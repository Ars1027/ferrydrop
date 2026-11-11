# FerryDrop 实现接口（前后端共同约定）

共享类型见 packages/protocol/src/index.ts；协议名称 FNP/1，WSS path `/ws`，subprotocol `ferrydrop.v1`。

HTTP POST `/api/enroll` body `{username,password,deviceName,publicJwk}` → `{deviceId}`，需口令认证，用户由 CLI 预先创建；已有设备保存在客户端 IDB。HTTP GET `/api/health` 返回 `{ok:true}`。生产同源 HTTPS，不提供公开注册。

RPC request `{v:1,id:uuid,type,body}`，reply `{v:1,id,type:'OK',body:result}` 或 `{v:1,id,type:'ERROR',body:{code,message}}`。服务器事件无 id。JSON 限 16 KiB。认证前只允许 AUTH_START/AUTH_PROOF。

RPC（返回值无特别说明则 `{}`）：
- AUTH_START `{deviceId}` → `{challengeId,signingText}`，服务端挑战绑定当前连接并过期；前端 ECDSA P256/SHA256 签名 UTF8 signingText。
- AUTH_PROOF `{challengeId,signature}` → Snapshot；signature base64 编码 WebCrypto P1363 原始签名。服务器验签 node crypto dsaEncoding ieee-p1363。
- STATE `{}` → Snapshot。事件 STATE body 同 Snapshot，房间/任务变化广播相关已认证连接。
- ROOM_CREATE `{}` → Room；code 为 8 位数字，15 分钟邀请/房间到期（可配置）。二维码以 location.origin + '/#room=' + code，由前端生成。房间码只发入房申请，不能自动授权。
- ROOM_JOIN `{code}` → `{roomId}`，发送待审批；ROOM_DECIDE `{roomId,deviceId,accept:boolean}` 仅房主。
- ROOM_CLOSE `{roomId}` 仅房主：取消未完成任务并删除房间记录，不保留关闭房间的号码；已完成传输回执保留。MEMBER_REMOVE `{roomId,deviceId}` 仅房主。
- FILE_OFFER `{roomId,receiverId,name,size,sha256}` → Transfer；receiverId 为 deviceId。
- FILE_DECIDE `{transferId,accept:boolean}` → Transfer；接受后 status uploading，拒绝 cancelled。
- UPLOAD_CREDIT `{transferId,bytes}` → `{offset,bytes}`，服务端按用户额度分配最多一块，当前连接单任务信用只授予一次，超时回收；随后发二进制 UPLOAD，成功事件 ACK `{transferId,offset}`。在 ACK 后继续信用请求。允许不同 transferId 交错。
- UPLOAD_FINISH `{transferId}` → Transfer，服务器验哈希后 ready。零字节文件可直接 finish。
- DOWNLOAD_CHUNK `{transferId,offset,maxBytes}`：服务端先发送 DOWNLOAD 二进制帧，再回 OK `{offset,bytes}`。客户端在调用前注册对应 transferId 的单个等待者，二进制处理持久化完再请求下一块。不同任务可交错并发。
- RECEIVED `{transferId,sha256}` → Transfer；客户端已校验；server 删除临时文件并 status cleaned，若删除失败保留 received + error。零字节直接校验确认。
- RESUME_QUERY `{transferId}` → Transfer；只返回已授权且未过期任务，offset 为服务端上传确认偏移；下载偏移由接收者本地持久化决定。
- CANCEL `{transferId}` → Transfer，发送/接收方均可；终态不可恢复。
- HEARTBEAT `{}` → `{time}`；ping/pong server 自动保活，前端每20秒应用心跳。
- DEVICES `{}` → Device[]（本人设备）；DEVICE_REVOKE `{deviceId,password}` 撤销本人设备，重验密码，关闭对应会话。
- ADMIN_USERS `{}` → User[]；ADMIN_TIER `{userId,tier}` → User，限管理员。

UI 暂停为停止请求新信用/新块，不改变全局任务状态；刷新重连后通过 RESUME_QUERY 续传。上传源文件需重选且校验完整哈希；下载按 OPFS 文件长度和 IDB 已保存偏移恢复。

Snapshot.devices 是同房间已批准可见设备（包括自己），Room.pending 只在房主视图包含请求。不同账户不可见其他无关账户的任务、公钥、房间。User.rate 为单方向 bytes/s 聚合额度。tier 为 standard/vip；默认 1MiB/s 和 4MiB/s，可配置。

前端保存设备材料 IDB，登录界面输入用户/密码登记；默认中文界面，品牌仅英文 FerryDrop。界面不得用静态虚构设备或进度代替真实后端数据。开发 http 只允许 localhost 显式开关，生产默认 HTTPS，证书缺失时启动失败并提示配置。

服务端导出 `createApp(options)` 供测试启动；options 至少 `{dataDir,host?,port?,insecure?,certPath?,keyPath?,webRoot?,standardRate?,vipRate?,maxFileSize?,retentionMs?,roomTtlMs?}`；返回 Fastify instance，测试 app.listen({host:'127.0.0.1',port:0})；另导出 `createUser(dataDir,username,password,tier?,admin?)` CLI/测试共用。
