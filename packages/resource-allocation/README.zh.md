# resource-allocation / 资源分配

**DeepSeek Harness 的会话归属长任务运行与只读队列观察插件。**

## 能力

- 注册 `resource_run`、`resource_status`、`resource_stop`、`resource_plan`、
  `resource_queue`；
- 把长任务作为独立 systemd transient unit 运行；
- 保留 session/goal/job 归属链；
- 展示孤儿进程、占位与等待项；
- 只能停止本会话拥有的、精确匹配的受管 run；
- 队列/策略只做记录，不启动、不杀进程、不自动限流。

`projectId` 和 `taskId` 是可选标签。匹配旧 manifest 时使用其 limits、
工作目录和环境变量；否则使用安全默认值或本次运行的显式覆盖。**不需要先注册
项目才能启动长任务。**

## 安装

```sh
dsh plugin --profile web add /absolute/path/resource-allocation-1.0.4.tgz
```

托管 run 需要 Linux + systemd；其他平台仍可使用观察和队列工具。

## 安全边界

`resource_stop` 会校验精确 unit 与 owner；接管的 unit 只观察；队列决策绝不
启动或杀进程。

## 已知限制

- HTML/API 路径暂时保留 `/resources/projects*` 一版兼容；UI 已改为资源台账。

## 许可证

MIT。
