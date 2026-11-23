# BuddyRelay 用户中转站

需要 Node.js 24.13+。在此目录执行 `npm start`，打开 `http://127.0.0.1:8787`，管理员入口为 `/admin`。首次启动的管理账号保存在 `data/admin-access.txt`。在账户设置中修改密码后重新登录。

用户可注册、创建及撤销 API Key、选择模型进行流式或非流式对话、查看积分余额和调用账单。新用户初始余额为 0，管理员在后台调整积分，调整操作支持幂等处理。

管理员可配置多个 OpenAI 兼容来源。在“账号与来源”中逐个发起 WorkBuddy 官方登录，完成授权后自动保存账号、启用国内或国际反代池并同步模型。新同步的模型默认关闭，需要在“模型定价”中设置价格并启用。已有账号库可点击接入相应版本的账号池。

在“账号与来源”点击账号旁的“查看积分”可查询 WorkBuddy 可用积分、各积分包来源、已用额度及到期时间。

## 计费和缓存

输入和输出价格为整数积分 / 千 Token，按次费用精确到 0.001 积分。数据库以千分之一积分记账。调用前根据输入字节数和最大输出 Token 预扣上限，完成后按上游 usage 结算。上游缺失有效 usage 时收取预扣上限，上游返回超出预估的用量时最高收取预扣金额。当前最大输出为 8192 Token，每用户最多 3 个并发请求。

调用失败且尚未输出流式内容时全额退款。流式中断或进程异常退出时保留预扣积分，由管理员在“缓存与核对”中确认实际收费并退回差额。每次调用可传 `Idempotency-Key`。相同用户重复提交相同非流式请求可读取原结果，待处理和流式重复请求返回 409。

回答缓存需要用户发送 `cache: true`，同时使用 `temperature: 0`、非流式且无 tools/functions。缓存按用户隔离，每个模型可设置有效秒数与命中收费比例。缓存命中费用为当前模型按次费用乘以比例。上游自身的提示词缓存费用目前按上游 usage 的输入 Token 统一计入输入价格。

当前充值由管理员手动调整积分。注册不验证邮箱，密码恢复通过运营人员处理。此版本 API 提供 `/v1/models` 和 `/v1/chat/completions`。

## 服务器部署

`PORTAL_HOST`、`PORTAL_PORT` 决定监听，默认 `127.0.0.1:8787`，`PORTAL_DATA` 指定持久化目录。`PORTAL_SECURE_COOKIE=1` 在 HTTPS 部署中启用 Secure Cookie。公网只提供用户站点，账号管理服务继续在本机回环地址运行。

`PORTAL_UPSTREAM` 用于初始化 Magpie 来源，`PORTAL_UPSTREAM_KEY` 可在首次启动时设置其密钥。TCP 模式下默认使用 `http://127.0.0.1:3425/v1`，设置 `PORTAL_SOCKET` 时需显式配置该来源。`PORTAL_ACCOUNT_API` 默认 `http://127.0.0.1:57890`，`PORTAL_ACCOUNT_TOKEN` 为本机账号管理服务口令，需与 `WB_SWITCH_TOKEN` 相同。

Hostinger 当前部署使用 Node.js 24 私有进程和 PHP cURL 入口转发，三个服务通过私有 Unix Socket 通信。`PORTAL_SOCKET` 为 Node 入口套接字路径，`PORTAL_SOCKET_DIR` 和 `WB_SWITCH_SOCKET_DIR` 指向存放账号服务及国内、国际反代套接字的私有目录。该部署适配共享主机对回环 TCP 的限制。

`hostinger-index.php` 和 `hostinger.htaccess` 位于公开网站根目录，其余程序与数据在用户主目录下的私有 `buddyrelay-portal`。`run-hostinger.sh` 监督 Node 和 WorkBuddy 账号进程。网关运行期间每分钟检查守护进程，并在 WorkBuddy 私有套接字拒绝连接时尝试立即恢复。可通过 SSH 执行 `sh run-hostinger.sh --ensure` 拉起服务，也可在 hPanel 中定时执行该命令以恢复整站停机。部署使用单个 Node 进程和 SQLite 文件。

备份整个私有 data 目录时先暂停写入，或使用 SQLite 在线备份。数据库含密码哈希、上游 API Key、用户回答缓存及账单，需限制到部署账户可读。WorkBuddy 账号文件独立保存在 `workbuddy-data/.wb-switch`。
