# CFL Aru Host

这个 fork 在 Linux 上提供无桌面的 Aru 手机接入节点，连接同机已有 CFL。
节点只呈现 CFL 的一位电脑协作者和一个固定既有会话。CFL/Codex 继续持有
伴侣身份、执行和原生历史，原 Lamplit 网页仍访问同一会话。

支持文字、图片、完成回复多气泡、历史分页、生成中插话、精确回合停止和
断线恢复。未知提交只查询原操作回执，不自动重发。Host 关闭不会停止 CFL。

**真实 Aru iOS 验收待完成。** 协议与隔离服务测试不能证明已发布手机接受
受限能力、单会话目录、图片和插话。本 PR 不部署、不接入真实伴侣或配对手机。
完成 [实机清单](docs/device-acceptance.md) 后才考虑实际接入。

## 开发与启动

需要 Node 24 和 Bun 1.3.14；无需桌面、容器运行时或第二份 Codex。

```sh
bun install --frozen-lockfile
bun run build
./run-node.sh --data-dir /tmp/aru-cfl-example \
  --cfl-origin http://127.0.0.1:3082 --base-url http://host.example:8787
```

`--data-dir` 必须是本服务独立目录；不要指定原完整 Host/CFL/Codex 的数据目录。
示例地址由操作者替换。手机访问的 `--base-url` 是网络路由，不是节点身份。
默认仅监听 loopback；需要 LAN 时显式设置 `--listen-host 0.0.0.0`，HTTPS 由
操作者已有反向代理提供。输出的单次 `aru://pair` 链接可由操作者编码为 QR。
令牌 10 分钟过期；手机配对后使用可撤销的设备凭据。

若 CFL 需要认证，用服务私有的 JSON 文件配置 `authorization` 或 `cookie`
header，并传 `--upstream-headers-file /path/to/private-headers.json`。
文件权限建议 0600；它不进入发行包、Git 或手机响应。不得使用手机凭据代替。

[操作参考](docs/operator-reference.md) 包含配置、配对、撤销、包与更新；
[架构](docs/architecture.md) 与 [生命周期](HOST-LIFECYCLE.md) 说明权威和恢复边界。

## 验证和发行

```sh
node --test tests/cfl-text.test.mjs
node tools/prepare-cfl-fixture.mjs /tmp/new-cfl-fixture /path/to/read-only-cfl-checkout
CFL_TEST_CHECKOUT=/tmp/new-cfl-fixture/checkout node --test tests/cfl-real-integration.mjs
./package-release.sh /tmp/aru-cfl-host.tar.gz
```

包包含已编译公共合同和生产依赖，不依赖相邻源码。sharp 是原生依赖，必须在
目标 OS/架构上打包；Linux CI 在 Linux 构建并运行自包含公共合同/解包包测试；真实 CFL/native
integration 单独在明确的本地固定归档中验收，不作为 CI 的假冒结论。
更新仅接受显式校验过的本 fork 包，不自动下载原官方 Host。包不会替操作者
安装/启动/重启现有服务；本任务也不发布 GitHub release 或部署。

## 能力边界与许可

不提供新建/删除/归档会话、创建协作者、编辑人设/权限、记忆、主动规则、
phone-local replicas、MCP、工作区、小应用、语音或推送。相应路由返回明确
不支持，不把缺能力伪装成空记忆。CFL 的普通主动消息仍作为会话消息可读。
执行审批策略是 CFL 的 `never`；Ar​​u wire 的 `approvalMode: always_allow`
表示不会请求手机审批，**不能解释为手机确认正在保护执行**。

基于 [Aevella/aru-host](https://github.com/Aevella/aru-host)，保留 Apache-2.0
[LICENSE](LICENSE)。公共合同来源与许可见
[vendor/lamplit-contracts/PROVENANCE.md](vendor/lamplit-contracts/PROVENANCE.md)。
上游桌面/完整 Host 源码保留作历史参考，不是本 fork 的受支持运行路径。
