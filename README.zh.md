# DSH Resource Platform / DSH 资源平台

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供宿主机资源保护、长任务分配与会话级资源监控。

## 包含三个组合包

| 包 | 版本 | 作用 |
|---|---|---|
| `hardware-guard` | 1.0.1 | 主机硬件探测、压力守卫、watchdog、沙箱包装、磁盘清理 |
| `resource-allocation` | 1.0.4 | 会话归属的受管长任务、可选标签、孤儿进程观察、只读队列/策略 |
| `resource-allocation-ui` | 1.0.5 | 资源页：本会话/其他会话台账、进程查询、磁盘清理 |

## 独特性

GitHub 上没有发现完全相同的插件。现有 `dsh-monitor-pro`、`dsh-resource-monitor`、`dsh-sysmon` 等主要是只读监控面板，不管理长任务生命周期；`dsh-disk-doctor`、`dsh-disk-guard` 与磁盘清理有重叠，但不提供主机压力守卫和受管运行。`xychendave/dsh-hardware-guard` 是物理硬件/机器人安全工具，不是主机资源守卫。

本项目的 UI 是**资源台账**，不是项目注册表。项目/任务 ID 只是可选标签，不再是运行前置条件。

## 安装

```sh
dsh plugin --profile web add /absolute/path/hardware-guard-1.0.1.tgz
dsh plugin --profile web add /absolute/path/resource-allocation-1.0.4.tgz
dsh plugin --profile web add /absolute/path/resource-allocation-ui-1.0.5.tgz
```

安装后重启 DSH。

也可以从源码目录安装：

```sh
dsh plugin --profile web add ./packages/hardware-guard
dsh plugin --profile web add ./packages/resource-allocation
dsh plugin --profile web add ./packages/resource-allocation-ui
```

UI 包已自带 `dsh.bundle` patch，不需要再手动插入资源页 row。

## 安全边界

- `hardware-guard` 首次启动为 dry-run，操作者确认 profile 后才进入 enforcement；
- `resource_run` 只创建自己的 systemd transient unit；
- `resource_stop` 只能停止本会话拥有的受管 run；
- adopted units 永远只观察，不启动/停止/重启；
- 队列决策只写 queue/policy，不杀进程；
- 磁盘清理只列候选，必须显式选择“移到回收站”或“永久删除”。

## 兼容与测试

- Node.js 20+；
- DSH `>=0.2.0-rc.2 <0.3.0`（开发验证于 0.2.1-rc.1）；
- 托管 run 需要 Linux + systemd。

```sh
node packages/resource-allocation-ui/smoke/bundle-smoke.mjs
node scripts/check-release.mjs
```

内部主机测试在开发 checkout 中针对对应 `@deepseek-ai/*` peer packages 运行；测试样例不随公开包发布。

## 许可证

MIT。
