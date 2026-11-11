import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import {
  type Snapshot,
  type Transfer,
  type Device,
  type User,
} from "@ferrydrop/protocol";
import { client, hash } from "./client";
import { get, put } from "./storage";
import { downloadFile } from "./save";
import "./style.css";
const size = (n: number) => {
  const units = ["B", "KB", "MB", "GB"];
  const unit = Math.min(
    3,
    Math.floor(Math.log(Math.max(1, n)) / Math.log(1024)),
  );
  return `${Number((n / 1024 ** unit).toFixed(unit ? 1 : 0))} ${units[unit]}`;
};
const labels: Record<string, string> = {
  offered: "等待接收确认",
  uploading: "正在上传",
  ready: "等待下载",
  downloading: "正在接收",
  received: "校验完成 · 等待清理",
  cleaned: "交付完成 · 服务端副本已清理",
  cancelled: "已取消",
  expired: "已过期",
  failed: "传输失败",
};
function App() {
  const [s, S] = useState<Snapshot>(),
    [status, Status] = useState("尚未连接"),
    [error, E] = useState(""),
    [saveNotice, SaveNotice] = useState(""),
    [page, P] = useState("work"),
    [room, R] = useState(""),
    [revoke, Revoke] = useState<Device>(),
    [roomEntry, ShowRoomEntry] = useState(false),
    [joinNotice, JoinNotice] = useState(""),
    [joiningRoom, JoiningRoom] = useState(""),
    [receiver, V] = useState(""),
    [code, C] = useState(
      new URLSearchParams(location.hash.slice(1)).get("room") || "",
    ),
    [qr, Q] = useState(""),
    [files, F] = useState<File[]>([]),
    [sources] = useState(new Map<string, File>()),
    [paused] = useState(new Set<string>()),
    [running] = useState(new Set<string>()),
    [progress, G] = useState<Record<string, number>>({}),
    [saved, B] = useState<Record<string, File>>({}),
    [devices, D] = useState<Device[]>([]),
    [users, U] = useState<User[]>([]),
    [busy, Busy] = useState(false),
    [quota, K] = useState("");
  const act = async (fn: () => Promise<any>) => {
    try {
      E("");
      return await fn();
    } catch (e) {
      E(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    client.onstate = S;
    client.onstatus = Status;
    client.connect();
    history.replaceState(null, "", location.pathname);
    navigator.storage
      ?.estimate()
      .then((q) => K(`可用空间约 ${size((q.quota || 0) - (q.usage || 0))}`));
  }, []);
  const active = s?.rooms.find((r) => r.id === room) || s?.rooms[0];
  useEffect(() => {
    if (receiver && !active?.members.some((d) => d.id === receiver)) V("");
    if (!active) Q("");
  }, [active, receiver]);
  useEffect(() => {
    if (!joiningRoom) return;
    if (
      s?.rooms.some(
        (r) =>
          r.id === joiningRoom && r.members.some((d) => d.id === s.deviceId),
      )
    ) {
      JoinNotice("");
      JoiningRoom("");
      return;
    }
    const timeout = setTimeout(() => {
      JoinNotice("尚未获准加入，可重新申请或联系房主确认。");
      JoiningRoom("");
    }, 60000);
    return () => clearTimeout(timeout);
  }, [
    joiningRoom,
    s?.rooms.some(
      (r) => r.id === joiningRoom && r.members.some((d) => d.id === s.deviceId),
    ),
  ]);

  useEffect(() => {
    if (active)
      QRCode.toDataURL(`${location.origin}/#room=${active.code}`, {
        margin: 1,
        width: 160,
        color: { dark: "#203833", light: "#fffdf7" },
      }).then(Q);
  }, [active?.code]);
  async function run(t: Transfer) {
    const uploading =
      t.senderId === s?.deviceId &&
      t.status === "uploading" &&
      sources.has(t.id);
    const downloading =
      t.receiverId === s?.deviceId &&
      ["ready", "downloading"].includes(t.status);
    if (!uploading && !downloading) return;
    if (running.has(t.id) || paused.has(t.id)) return;
    running.add(t.id);
    try {
      let current: Transfer = await client.rpc("RESUME_QUERY", {
        transferId: t.id,
      });
      if (current.senderId === s?.deviceId && current.status === "uploading") {
        const file = sources.get(t.id);
        if (!file) return;
        while (current.offset < file.size && !paused.has(t.id)) {
          const credit = await client.rpc("UPLOAD_CREDIT", {
            transferId: t.id,
            bytes: Math.min(s!.limits.chunkSize, file.size - current.offset),
          });
          const data = new Uint8Array(
            await file
              .slice(credit.offset, credit.offset + credit.bytes)
              .arrayBuffer(),
          );
          current.offset = await client.upload(t.id, credit.offset, data);
          G((p) => ({ ...p, [t.id]: current.offset }));
        }
        if (current.offset === file.size)
          await client.rpc("UPLOAD_FINISH", { transferId: t.id });
      }
      if (
        current.receiverId === s?.deviceId &&
        ["ready", "downloading"].includes(current.status)
      ) {
        if (!navigator.storage?.getDirectory)
          throw Error("此浏览器不支持可恢复接收，请使用 Chrome 或 Edge。");
        const estimate = await navigator.storage.estimate();
        await navigator.storage.persist?.();
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(t.id, { create: true });
        let offset = Math.min(
          (await get<number>("offset:" + t.id)) || 0,
          (await handle.getFile()).size,
          current.size,
        );
        const truncate = await handle.createWritable({
          keepExistingData: true,
        });
        await truncate.truncate(offset);
        await truncate.close();
        if (
          (estimate.quota || 0) - (estimate.usage || 0) <
          current.size - offset
        )
          throw Error("浏览器剩余空间不足，请释放空间后重试");
        while (offset < current.size && !paused.has(t.id)) {
          const chunk = await client.download(
            t.id,
            offset,
            s!.limits.chunkSize,
          );
          if (chunk.offset !== offset) throw Error("接收位置不一致，请重试");
          const writer = await handle.createWritable({
            keepExistingData: true,
          });
          try {
            await writer.write({
              type: "write",
              position: offset,
              data: chunk.payload as any,
            });
            await writer.close();
          } catch (e) {
            await writer.abort();
            throw e;
          }
          offset += chunk.payload.length;
          await put("offset:" + t.id, offset);
          G((p) => ({ ...p, [t.id]: offset }));
        }
        if (offset === current.size) {
          const file = await handle.getFile();
          if ((await hash(file)) !== current.sha256)
            throw Error("文件校验失败，未确认交付");
          B((p) => ({ ...p, [t.id]: file }));
          await client.rpc("RECEIVED", {
            transferId: t.id,
            sha256: current.sha256,
          });
        }
      }
    } catch (e) {
      const latest = client.state?.transfers.find((item) => item.id === t.id);
      if (
        latest &&
        ["received", "cleaned", "cancelled", "expired", "failed"].includes(
          latest.status,
        )
      )
        return;
      E(`${t.name}：${String(e)}`);
      paused.add(t.id);
    } finally {
      running.delete(t.id);
    }
  }
  useEffect(() => {
    s?.transfers.forEach((t) => {
      run(t);
      if (
        t.receiverId === s.deviceId &&
        ["cleaned", "received"].includes(t.status) &&
        !saved[t.id]
      )
        navigator.storage
          ?.getDirectory?.()
          .then((r) => r.getFileHandle(t.id))
          .then((h) => h.getFile())
          .then((f) => B((p) => ({ ...p, [t.id]: f })))
          .catch(() => {});
    });
  }, [s]);
  async function enroll(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    Busy(true);
    await act(async () => {
      const f = new FormData(e.currentTarget);
      const keys = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      const response = await fetch("/api/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: f.get("username"),
          password: f.get("password"),
          deviceName: f.get("deviceName"),
          publicJwk: await crypto.subtle.exportKey("jwk", keys.publicKey),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.message || "登记失败");
      await put("identity", {
        deviceId: result.deviceId,
        privateKey: keys.privateKey,
      });
      await client.connect();
    });
    Busy(false);
  }
  async function offer() {
    Busy(true);
    await act(async () => {
      if (!active || !receiver) throw Error("请先选择房间与收件设备");
      for (const file of files) {
        if (file.size > s!.limits.maxFileSize)
          throw Error("文件超过服务允许的大小");
        const sha256 = await hash(file);
        const t = await client.rpc("FILE_OFFER", {
          roomId: active.id,
          receiverId: receiver,
          name: file.name,
          size: file.size,
          sha256,
        });
        sources.set(t.id, file);
      }
      F([]);
      const fresh = await client.rpc("STATE");
      S(fresh);
    });
    Busy(false);
  }
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="#">
          FerryDrop<span>临时文件，明确交付。</span>
        </a>
        <nav>
          <button
            className={page === "work" ? "selected" : ""}
            onClick={() => P("work")}
          >
            ↗ 文件工作台
          </button>
          <button
            className={page === "devices" ? "selected" : ""}
            onClick={() => {
              P("devices");
              act(async () => D(await client.rpc("DEVICES")));
            }}
          >
            ◎ 我的设备
          </button>
          {s?.user.admin && (
            <button
              onClick={() => {
                P("admin");
                act(async () => U(await client.rpc("ADMIN_USERS")));
              }}
            >
              ≡ 身份策略
            </button>
          )}
        </nav>
        <div className="identity">
          <span className={status === "已连接" ? "dot online" : "dot"} />
          {status}
          {s && (
            <>
              <strong>{s.user.username}</strong>
              <small>
                {s.user.tier === "vip" ? "VIP" : "普通用户"} ·{" "}
                {size(s.user.rate)}/秒
              </small>
              <button onClick={() => act(() => client.forget())}>
                注销此设备身份
              </button>
            </>
          )}
        </div>
      </aside>
      <main>
        <header>
          <span>你的交付工作台</span>
          <span className="edition">FERRYDROP / 01</span>
        </header>
        {saveNotice && (
          <div role="status" className="save-notice">
            {saveNotice}
          </div>
        )}
        {error && (
          <div role="alert" className="error">
            {error}
            <button onClick={() => E("")}>关闭</button>
          </div>
        )}
        {!s ? (
          <section className="welcome">
            <p className="eyebrow">连接这台设备</p>
            <h1>
              让文件，
              <br />
              抵达另一端。
            </h1>
            <p>使用管理员提供的账户登记设备，随后创建房间或输入房间码。</p>
            <button
              className="quiet"
              onClick={() => act(() => client.forget())}
            >
              清除旧身份并重新登记
            </button>
            <form onSubmit={enroll}>
              <label>
                用户名
                <input name="username" autoComplete="username" required />
              </label>
              <label>
                密码
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
              <label>
                这台设备的名称
                <input
                  name="deviceName"
                  placeholder="例如：我的笔记本"
                  required
                  maxLength={80}
                />
              </label>
              <button className="primary" disabled={busy}>
                {busy ? "正在登记…" : "登记并连接 →"}
              </button>
            </form>
          </section>
        ) : page === "work" ? (
          <>
            <div className="heading">
              <div>
                <p className="eyebrow">文件交付 / WORKSPACE</p>
                <h1>
                  交给谁，
                  <br className="mobile" />
                  由你决定。
                </h1>
              </div>
              <p>
                创建一个临时房间。
                <br />
                审批设备，再开始交付。
              </p>
            </div>
            <section className="roomgrid">
              <div>
                <h2>
                  01 <span>连接房间</span>
                </h2>
                {active && (
                  <button
                    className="quiet room-toggle"
                    onClick={() => ShowRoomEntry(!roomEntry)}
                    aria-expanded={roomEntry}
                  >
                    {roomEntry ? "收起房间入口" : "其他房间 / 创建加入 →"}
                  </button>
                )}
                {(!active || roomEntry) && (
                  <div className="actions room-entry">
                    <button
                      className="primary"
                      onClick={() =>
                        act(async () => {
                          const r = await client.rpc("ROOM_CREATE");
                          R(r.id);
                          ShowRoomEntry(false);
                        })
                      }
                    >
                      创建房间 ＋
                    </button>
                    <input
                      aria-label="房间码"
                      placeholder="输入 8 位房间码"
                      value={code}
                      maxLength={8}
                      onChange={(e) => C(e.target.value)}
                    />
                    <button
                      onClick={() =>
                        act(async () => {
                          const joined = await client.rpc("ROOM_JOIN", {
                            code,
                          });
                          JoiningRoom(joined.roomId);
                          JoinNotice("申请已发送，请等待房主审批。");
                        })
                      }
                    >
                      申请加入 →
                    </button>
                  </div>
                )}
                {joinNotice && (
                  <p className="join-notice" role="status">
                    {joinNotice}
                  </p>
                )}
                {s.rooms.length > 1 && (
                  <select
                    aria-label="当前房间"
                    value={active?.id}
                    onChange={(e) => R(e.target.value)}
                  >
                    {s.rooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.code}
                        {r.closed ? " · 已关闭" : ""}
                      </option>
                    ))}
                  </select>
                )}
                {active ? (
                  <>
                    <div className="room-state" role="status">
                      {active.closed
                        ? "已关闭"
                        : active.expiresAt <= Date.now()
                          ? "已连接 · 邀请已到期"
                          : "已连接"}
                    </div>
                    <div className="invitation">
                      <div>
                        <small>
                          房间码 ·{" "}
                          {active.closed
                            ? "已关闭"
                            : active.expiresAt <= Date.now()
                              ? "邀请已到期"
                              : "邀请有效至 " +
                                new Date(active.expiresAt).toLocaleTimeString()}
                        </small>
                        <strong>
                          {active.code.slice(0, 4)} {active.code.slice(4)}
                        </strong>
                        <p>扫码申请加入，房主确认后连接。</p>
                      </div>
                      {qr && <img src={qr} alt="房间邀请二维码" />}
                    </div>
                    {active.pending.map((d) => (
                      <div className="row" key={d.id}>
                        <span>
                          {d.name} · {d.username} 申请加入
                        </span>
                        <button
                          onClick={() =>
                            act(() =>
                              client.rpc("ROOM_DECIDE", {
                                roomId: active.id,
                                deviceId: d.id,
                                accept: true,
                              }),
                            )
                          }
                        >
                          允许
                        </button>
                        <button
                          onClick={() =>
                            act(() =>
                              client.rpc("ROOM_DECIDE", {
                                roomId: active.id,
                                deviceId: d.id,
                                accept: false,
                              }),
                            )
                          }
                        >
                          拒绝
                        </button>
                      </div>
                    ))}
                    {active.ownerId === s.deviceId && (
                      <button
                        className="quiet"
                        onClick={() => {
                          if (confirm("关闭房间会取消未完成任务，确定关闭？"))
                            act(() =>
                              client.rpc("ROOM_CLOSE", { roomId: active.id }),
                            );
                        }}
                      >
                        关闭房间
                      </button>
                    )}
                  </>
                ) : (
                  <p className="empty">
                    还没有房间。创建房间，或向对方索取房间码。
                  </p>
                )}
              </div>
              <div className="recipients">
                <h2>
                  02 <span>选择收件设备</span>
                </h2>
                {active?.members
                  .filter((d) => d.id !== s.deviceId)
                  .map((d) => (
                    <div
                      className={receiver === d.id ? "device chosen" : "device"}
                      key={d.id}
                    >
                      <label>
                        <input
                          type="radio"
                          name="receiver"
                          checked={receiver === d.id}
                          onChange={() => V(d.id)}
                        />
                        <span>
                          <strong>{d.name}</strong>
                          <small>
                            {d.username} · {d.online ? "在线" : "离线"}
                            {receiver === d.id && (
                              <span className="chosen-label">
                                将发送至此设备
                              </span>
                            )}
                          </small>
                        </span>
                      </label>
                      {active.ownerId === s.deviceId && (
                        <button
                          onClick={() =>
                            act(() =>
                              client.rpc("MEMBER_REMOVE", {
                                roomId: active.id,
                                deviceId: d.id,
                              }),
                            )
                          }
                        >
                          移除
                        </button>
                      )}
                    </div>
                  ))}
                {!active?.members.some((d) => d.id !== s.deviceId) && (
                  <p className="empty">收件设备将在批准加入后出现在这里。</p>
                )}
              </div>
            </section>
            <section className="compose">
              <h2>
                03 <span>准备交付</span>
              </h2>
              <label
                className="drop"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  F((p) => [...p, ...Array.from(e.dataTransfer.files)]);
                }}
              >
                <span className="plus">＋</span>
                <strong>把文件放在这里</strong>
                <span>或点击选择 · 支持多个文件</span>
                <input
                  type="file"
                  multiple
                  onChange={(e) =>
                    F((p) => [...p, ...Array.from(e.target.files || [])])
                  }
                />
              </label>
              {files.map((f, i) => (
                <div className="row" key={i}>
                  <span>{f.name}</span>
                  <small>{size(f.size)}</small>
                  <button onClick={() => F((p) => p.filter((_, j) => j !== i))}>
                    移除
                  </button>
                </div>
              ))}
              {files.length > 0 && (
                <button
                  className="primary"
                  disabled={busy || !receiver || active?.closed}
                  onClick={offer}
                >
                  {busy ? "正在校验文件…" : `交付 ${files.length} 个文件 →`}
                </button>
              )}
            </section>
            <section className="queue">
              <div className="sectionhead">
                <h2>
                  交付队列{" "}
                  <small>
                    {s.transfers.length.toString().padStart(2, "0")}
                  </small>
                </h2>
                <small>{quota}</small>
              </div>
              {s.transfers.length === 0 && (
                <p className="empty">
                  还没有交付任务。选好收件设备，添加第一份文件。
                </p>
              )}
              {s.transfers.map((t) => (
                <article className="task" key={t.id}>
                  <div className="tasktitle">
                    <span className="direction">
                      {t.senderId === s.deviceId ? "↗ 发送" : "↙ 接收"}
                    </span>
                    <strong>{t.name}</strong>
                    <span>{size(t.size)}</span>
                  </div>
                  <div className="taskmeta">
                    <span>
                      {paused.has(t.id)
                        ? "已暂停 · 可继续"
                        : t.receiverId === s.deviceId &&
                            ["cleaned", "received"].includes(t.status)
                          ? saved[t.id]
                            ? "已接收并校验 · 请保存到设备"
                            : "已接收并校验 · 本地副本不可用"
                          : labels[t.status]}
                      {t.receiverId === s.deviceId &&
                        ["cleaned", "received"].includes(t.status) && (
                          <small className="receipt-detail">
                            {t.status === "cleaned"
                              ? "服务端临时副本已清理"
                              : "服务端临时副本等待清理"}
                          </small>
                        )}
                      {t.error && ` · ${t.error}`}
                    </span>
                    <span>
                      {Math.round(
                        Math.min(
                          100,
                          ((progress[t.id] ?? t.offset) / Math.max(1, t.size)) *
                            100,
                        ),
                      )}
                      %
                    </span>
                  </div>
                  <progress
                    max={Math.max(1, t.size)}
                    value={
                      ["cleaned", "received"].includes(t.status)
                        ? Math.max(1, t.size)
                        : (progress[t.id] ?? t.offset)
                    }
                  />
                  <div className="actions">
                    {t.status === "offered" && t.receiverId === s.deviceId && (
                      <>
                        <button
                          className="primary"
                          onClick={() =>
                            act(() =>
                              client.rpc("FILE_DECIDE", {
                                transferId: t.id,
                                accept: true,
                              }),
                            )
                          }
                        >
                          接收文件
                        </button>
                        <button
                          onClick={() =>
                            act(() =>
                              client.rpc("FILE_DECIDE", {
                                transferId: t.id,
                                accept: false,
                              }),
                            )
                          }
                        >
                          拒绝
                        </button>
                      </>
                    )}
                    {["uploading", "ready", "downloading"].includes(
                      t.status,
                    ) && (
                      <>
                        <button
                          onClick={() => {
                            if (paused.has(t.id)) {
                              paused.delete(t.id);
                              run(t);
                            } else paused.add(t.id);
                            G((p) => ({ ...p }));
                          }}
                        >
                          {paused.has(t.id) ? "继续" : "暂停"}
                        </button>
                        {t.senderId === s.deviceId && !sources.has(t.id) && (
                          <label className="filebutton">
                            重选源文件以恢复
                            <input
                              type="file"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f)
                                  act(async () => {
                                    if (
                                      f.size !== t.size ||
                                      (await hash(f)) !== t.sha256
                                    )
                                      throw Error("所选文件与原文件不一致");
                                    sources.set(t.id, f);
                                    paused.delete(t.id);
                                    run(t);
                                  });
                              }}
                            />
                          </label>
                        )}
                        <button
                          onClick={() =>
                            act(() =>
                              client.rpc("CANCEL", { transferId: t.id }),
                            )
                          }
                        >
                          取消任务
                        </button>
                      </>
                    )}
                    {saved[t.id] && (
                      <>
                        <button
                          className="primary"
                          onClick={() =>
                            act(async () => {
                              const file = saved[t.id];
                              SaveNotice("");
                              downloadFile(file, t.name);
                              SaveNotice(
                                "已请求浏览器下载，请在浏览器下载列表中查看。文件副本仍保留。",
                              );
                            })
                          }
                        >
                          保存到设备 ↓
                        </button>
                        <button
                          onClick={() => {
                            if (
                              confirm(
                                "删除浏览器内的文件副本？请先确认已保存。",
                              )
                            )
                              act(async () => {
                                await (
                                  await navigator.storage.getDirectory()
                                ).removeEntry(t.id);
                                B((p) => {
                                  const next = { ...p };
                                  delete next[t.id];
                                  return next;
                                });
                              });
                          }}
                        >
                          删除本地副本
                        </button>
                      </>
                    )}
                    {t.status === "received" && (
                      <button
                        onClick={() =>
                          act(() =>
                            client.rpc("RECEIVED", {
                              transferId: t.id,
                              sha256: t.sha256,
                            }),
                          )
                        }
                      >
                        重试清理回执
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </section>
          </>
        ) : page === "devices" ? (
          <section>
            <p className="eyebrow">账户 / DEVICES</p>
            <h1>你的设备。</h1>
            <p>撤销后，该设备将无法继续连接。重新登记需要账户密码。</p>
            {revoke && (
              <form
                className="revoke-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const password = String(
                    new FormData(form).get("revokePassword"),
                  );
                  const deviceId = revoke.id;
                  act(async () => {
                    await client.rpc("DEVICE_REVOKE", { deviceId, password });
                    Revoke(undefined);
                    D(await client.rpc("DEVICES"));
                  });
                  form.reset();
                }}
              >
                <strong>撤销 {revoke.name}</strong>
                <label>
                  输入账户密码确认
                  <input
                    autoFocus
                    type="password"
                    name="revokePassword"
                    autoComplete="current-password"
                    required
                  />
                </label>
                <div className="actions">
                  <button className="primary" type="submit">
                    确认撤销
                  </button>
                  <button type="button" onClick={() => Revoke(undefined)}>
                    取消
                  </button>
                </div>
              </form>
            )}
            {devices.map((d) => (
              <div className="row" key={d.id}>
                <span>
                  <strong>{d.name}</strong>
                  <small>
                    {d.online ? "在线" : "离线"}
                    {d.id === s.deviceId ? " · 当前设备" : ""}
                  </small>
                </span>
                <button onClick={() => Revoke(d)}>撤销设备</button>
              </div>
            ))}
          </section>
        ) : (
          <section>
            <p className="eyebrow">管理 / POLICY</p>
            <h1>身份与带宽。</h1>
            <p>等级由服务端统一执行，多个任务共享账户额度。</p>
            {users.map((u) => (
              <div className="row" key={u.id}>
                <strong>{u.username}</strong>
                <span>{size(u.rate)}/秒</span>
                <select
                  aria-label={`${u.username} 等级`}
                  value={u.tier}
                  onChange={(e) =>
                    act(async () => {
                      await client.rpc("ADMIN_TIER", {
                        userId: u.id,
                        tier: e.target.value,
                      });
                      U(await client.rpc("ADMIN_USERS"));
                    })
                  }
                >
                  <option value="standard">普通</option>
                  <option value="vip">VIP</option>
                </select>
              </div>
            ))}
          </section>
        )}
        <footer>
          FerryDrop <span>确认接收 · 完整校验 · 临时副本清理</span>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
