# resource-allocation-ui / 资源监控

**DSH Web GUI 的资源页。**

这是一个**按会话组织的资源台账**，不是项目注册表。项目/任务 ID 只是可选标签。

## 两个子页

1. 硬件
2. 资源监控（默认）

## 资源监控

- 本会话条目在顶部；
- 其他监控会话在下方按 session 分组，可折叠；
- 展示占位、等待队列项和孤儿进程；
- 停止受管任务或取消排队项需要确认；
- 已隐藏的行可以恢复；
- 按需只读查询 `/resources/processes.json`；
- 磁盘清理卡片支持扫描 profile roots + 浏览器额外目录，选择移到回收站或
  永久删除，并可查看/清空有界回收站。

## 安装

```sh
dsh plugin --profile web add /absolute/path/resource-allocation-ui-1.0.5.tgz
dsh plugin --profile web add ./packages/resource-allocation-ui
```

包同时声明 `dsh.bundle` 和 `dsh.client`，无需手动插入 row。

## 许可证

MIT。
