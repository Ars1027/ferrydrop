import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

async function login(page: Page, user: string, name: string) {
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill(user);
  await page
    .getByLabel("密码", { exact: true })
    .fill(`browser-test-${user}-2026`);
  await page.getByLabel("这台设备的名称").fill(name);
  await page.getByRole("button", { name: "登记并连接" }).click();
  await expect(page.getByRole("heading", { name: /交给谁/ })).toBeVisible();
}

test("two independent browser devices pair, consent, transfer both ways, resume identity and export", async ({
  browser,
}) => {
  const a = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const b = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const sender = await a.newPage(),
    receiver = await b.newPage();
  const errors: string[] = [];
  sender.on("pageerror", (e) => errors.push(e.message));
  receiver.on("pageerror", (e) => errors.push(e.message));
  await mkdir(resolve("assets/readme"), { recursive: true });
  await sender.goto("/");
  await sender.screenshot({
    path: "assets/readme/sign-in.png",
    fullPage: true,
  });
  await login(sender, "alice", "Windows · Studio");
  await login(receiver, "bob", "Android · Pocket");
  await sender.getByRole("button", { name: "创建房间" }).click();
  await expect(sender.locator(".invitation strong")).toBeVisible();
  const code = (
    await sender.locator(".invitation strong").innerText()
  ).replaceAll(" ", "");
  await receiver.getByRole("textbox", { name: "房间码" }).fill(code);
  await receiver.getByRole("button", { name: "申请加入" }).click();
  await sender.getByRole("button", { name: "允许", exact: true }).click();
  await sender.getByRole("radio").check();
  await receiver.getByRole("radio").check();
  const content = Buffer.from(
    "# FerryDrop\n浏览器之间的真实文件交付。\n",
    "utf8",
  );
  await sender.locator(".drop input").setInputFiles([
    { name: "实验设计说明.md", mimeType: "text/markdown", buffer: content },
    {
      name: "packet-sample.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(
        Array.from({ length: 3 * 1024 ** 2 }, (_, i) => i % 251),
      ),
    },
  ]);
  await sender.getByRole("button", { name: "交付 2 个文件" }).click();
  await expect(
    receiver.getByRole("button", { name: "接收文件", exact: true }),
  ).toHaveCount(2);
  // No file data may move before the explicit consent.
  await expect(sender.locator(".taskmeta").first()).toContainText(
    "等待接收确认",
  );
  await receiver.evaluate(() => scrollTo(0, 0));
  await receiver.screenshot({
    path: "assets/readme/receive-confirmation.png",
    fullPage: true,
  });
  await receiver
    .getByRole("button", { name: "接收文件", exact: true })
    .first()
    .click();
  await receiver
    .getByRole("button", { name: "接收文件", exact: true })
    .first()
    .click();
  await expect(sender.locator(".taskmeta").nth(1)).toContainText("正在上传");
  await sender.evaluate(() => scrollTo(0, 0));
  await sender.screenshot({
    path: "assets/readme/transfer-active.png",
    fullPage: true,
  });
  await expect(
    receiver.getByRole("button", { name: "保存到设备" }),
  ).toHaveCount(2, { timeout: 30_000 });
  await expect(
    sender.getByText("交付完成 · 服务端副本已清理", { exact: true }),
  ).toHaveCount(2);
  // Read the actual browser-private file, not a UI progress value.
  const actual = await receiver.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const handle of (root as any).values()) {
      if (handle.kind === "file") {
        const file = await handle.getFile();
        if (file.size < 1000) return await file.text();
      }
    }
  });
  expect(actual).toBe(content.toString("utf8"));
  await receiver.locator(".drop input").setInputFiles({
    name: "来自另一端.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Back to Windows"),
  });
  await receiver.getByRole("button", { name: "交付 1 个文件" }).click();
  await sender.getByRole("button", { name: "接收文件", exact: true }).click();
  await expect(sender.getByRole("button", { name: "保存到设备" })).toHaveCount(
    1,
  );
  await sender.evaluate(() => scrollTo(0, 0));
  await receiver.evaluate(() => scrollTo(0, 0));
  await sender.screenshot({
    path: "assets/readme/workspace-desktop.png",
    fullPage: true,
  });
  await receiver.screenshot({
    path: "assets/readme/workspace-mobile.png",
    fullPage: true,
  });
  await receiver.reload();
  await expect(
    receiver.getByRole("button", { name: "保存到设备" }),
  ).toHaveCount(2);
  // An exposed but aborted picker must not intercept the default download.
  await receiver.evaluate(() => {
    (window as any).pickerCalls = 0;
    (window as any).showSaveFilePicker = async () => {
      (window as any).pickerCalls++;
      throw new DOMException("The user aborted a request.", "AbortError");
    };
  });
  const downloadEvent = receiver.waitForEvent("download");
  await receiver.getByRole("button", { name: "保存到设备" }).first().click();
  const exported = await downloadEvent;
  expect(exported.suggestedFilename()).toBe("实验设计说明.md");
  const stream = await exported.createReadStream();
  const parts: Buffer[] = [];
  for await (const part of stream!) parts.push(Buffer.from(part));
  expect(Buffer.concat(parts)).toEqual(content);
  expect(await receiver.evaluate(() => (window as any).pickerCalls)).toBe(0);
  await expect(
    receiver.getByRole("button", { name: "选择保存位置" }),
  ).toHaveCount(0);
  await expect(receiver.getByRole("alert")).toHaveCount(0);
  // Browsers without a picker use exactly the same download button.
  await receiver.evaluate(() => {
    delete (window as any).showSaveFilePicker;
  });
  const retryDownload = receiver.waitForEvent("download");
  await receiver.getByRole("button", { name: "保存到设备" }).first().click();
  expect((await retryDownload).suggestedFilename()).toBe("实验设计说明.md");
  // The Windows/desktop context exports the reverse transfer the same way.
  const desktopDownload = sender.waitForEvent("download");
  await sender.getByRole("button", { name: "保存到设备" }).click();
  const desktopFile = await desktopDownload;
  expect(desktopFile.suggestedFilename()).toBe("来自另一端.txt");
  const desktopStream = await desktopFile.createReadStream();
  const desktopParts: Buffer[] = [];
  for await (const part of desktopStream!) desktopParts.push(Buffer.from(part));
  expect(Buffer.concat(desktopParts).toString()).toBe("Back to Windows");
  await expect(receiver.locator(".brand")).toContainText("FerryDrop");
  expect(
    await receiver.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  sender.once("dialog", (dialog) => dialog.accept());
  await sender.getByRole("button", { name: "关闭房间", exact: true }).click();
  await expect(sender.locator(".invitation")).toHaveCount(0);
  await expect(receiver.locator(".invitation")).toHaveCount(0);
  await expect(sender.getByRole("combobox", { name: "当前房间" })).toHaveCount(
    0,
  );
  await expect(
    receiver.getByRole("button", { name: "保存到设备" }),
  ).toHaveCount(2);
  const unexpectedResumes: string[] = [];
  for (const page of [sender, receiver]) {
    page.on("websocket", (socket) =>
      socket.on("framesent", (frame) => {
        if (typeof frame.payload === "string") {
          const message = JSON.parse(frame.payload);
          if (message.type === "RESUME_QUERY")
            unexpectedResumes.push(message.body.transferId);
        }
      }),
    );
  }
  await Promise.all([sender.reload(), receiver.reload()]);
  await expect(sender.getByRole("heading", { name: /交给谁/ })).toBeVisible();
  await expect(sender.locator(".invitation")).toHaveCount(0);
  await expect(
    receiver.getByRole("button", { name: "保存到设备" }),
  ).toHaveCount(2);
  for (const page of [sender, receiver]) {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  expect(unexpectedResumes).toEqual([]);
  await a.close();
  await b.close();
});
