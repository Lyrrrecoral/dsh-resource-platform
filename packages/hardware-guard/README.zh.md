# hardware-guard / 硬件守卫

**DeepSeek Harness 的宿主机硬件探测与资源守卫。**

这是主机资源守卫，不是物理硬件/机器人安全插件，也不管理其他项目的 systemd 服务。

## 能力

- 探测 CPU、内存、磁盘与 WSL/虚拟机信息，持久化主机 profile；
- 推导保守预算和后台任务上限；
- 带滞回的主机压力分级；
- 工具执行准入，并可终止真正的失控进程；
- 为受限 shell 包装 `nice` 与进程数限制；
- 记录有界事件并提出由事件驱动的 adaptation；
- 提供按需大文件清理扫描（扫描、回收站、永久删除、有界回收站管理）。

首次启动为 **dry-run**，操作者通过 `hardware_guard` 确认 profile 前不会启用
强制限制或自动终止。

## 安装

```sh
dsh plugin --profile web add /absolute/path/hardware-guard-1.0.1.tgz
```

或从目录安装：

```sh
dsh plugin --profile web add ./packages/hardware-guard
```

安装或替换后重启 DSH。

## 安全边界

接管的 unit 只观察；清理扫描不删除任何东西，只处理实时 plan 中列出、且通过
路径/类型/symlink 校验的普通文件。永久删除必须显式确认，回收站保留有上限。

## 许可证

MIT。
