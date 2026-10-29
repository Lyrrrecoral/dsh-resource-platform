window.__ModuleLoader__.load({
	id: "resource-allocation-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const jsx = react_jsx_runtime.jsx;
		const jsxs = react_jsx_runtime.jsxs;
		const Fragment = react_jsx_runtime.Fragment;
		const { useState, useEffect, useCallback, useRef } = react;

		// 0.2.x renamed the icon set (IconXxx16/14 -> IconXxxRegular/Medium/Artwork);
		// fall back to the 0.1.x names so one bundle serves both runtimes.
		const IconData = primitives.IconDataOutlineRegular ?? primitives.IconDataOutline16;
		const IconFolderClose = primitives.IconFolderCloseRegular ?? primitives.IconFolderClose16;
		const IconRefresh = primitives.IconRefreshOutlineRegular ?? primitives.IconRefreshOutline16;
		const IconCheck = primitives.IconCheckOutlineRegular ?? primitives.IconCheckOutline16;
		const IconClose = primitives.IconCloseOutlineRegular ?? primitives.IconCloseOutline16;
		const IconQueue = primitives.IconQueueOutlineRegular ?? primitives.IconQueueOutline14;

		const NS = "resources";
		const REFRESH_MS = 15000;
		const NOTES_STORAGE_KEY = "resource-allocation-notes";
		const LEGACY_NOTES_STORAGE_KEY = "dsh-ops-notes";
		const HIDDEN_MONITORS_KEY = "resource-allocation-hidden-monitors";
		const CLEANUP_EXTRA_ROOTS_KEY = "hardware-guard-cleanup-extra-roots";

		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"view.resources": "资源",
			"view.notes": "注释",
			"tab.guard": "硬件",
			"tab.monitor": "资源监控",
			"tab.projects": "项目",
			"guard.badge.active": "ENABLED",
			"guard.badge.disabled": "DISABLED",
			"guard.badge.dryrun": "DRY-RUN",
			"guard.badge.unknown": "UNKNOWN",
			"guard.refresh": "刷新",
			"guard.snapshotAt": "快照时间",
			"guard.help": "这里显示硬件守卫的实时状态：压力、内存/磁盘预算、告警迟滞、待确认的自动调整（adaptation）和最近事件。Disable/Enable 是整体开关；Confirm 是确认某条 adaptation。",
			"guard.cleanup": "磁盘清理",
			"guard.cleanupDisabled": "磁盘清理还没有开启。请先在系统配置里打开 cleanupProbe。",
			"guard.cleanupHelp": "扫描指定文件夹里的大文件，先列出来给你看，不会自动删除。勾选后可以移到回收站，或者永久删除。系统目录、虚拟环境和缓存不会被扫描。",
			"guard.cleanupScan": "扫描大文件",
			"guard.cleanupSelectAll": "全选",
			"guard.cleanupClear": "清空选择",
			"guard.cleanupConfirm": "清理选中",
			"guard.cleanupConfirmTrash": "移到回收站",
			"guard.cleanupConfirmDelete": "永久删除",
			"guard.cleanupEmpty": "未发现候选文件。",
			"guard.cleanupSkipped": "已跳过系统/依赖目录",
			"guard.cleanupTrashDir": "回收站位置",
			"guard.cleanupRoots": "默认扫描位置",
			"guard.cleanupExtraRootsLabel": "额外要扫描的文件夹（可选）",
			"guard.cleanupExtraRootsPlaceholder": "一行一个文件夹，例如 /path/to/large-output",
			"guard.cleanupExtraRootsHelp": "不填也可以。这里加的文件夹只保存在当前浏览器。",
			"guard.cleanupPermanentHint": "永久删除不会进入回收站，删了就找不回来。",
			"guard.cleanupTrashSummary": "回收站",
			"guard.cleanupTrashView": "查看回收站",
			"guard.cleanupTrashEmpty": "清空回收站",
			"guard.cleanupTrashConfirm": "确定永久清空回收站？删除后找不回来。",
			"guard.cleanupTrashDone": "已清空回收站",
			"guard.cleanupSelected": "已选",
			"guard.cleanupDaysAgo": " 天前",
			"guard.cleanupHoursAgo": " 小时前",
			"guard.cleanupTrashUnknown": "未查看",
			"guard.cleanupFailedCount": "失败",
			"guard.controlSwitch": "控制开关",
			"guard.pressure": "压力",
			"guard.budget": "预算",
			"guard.policy": "内存上限策略 memoryCapPolicy",
			"guard.adaptations": "Adaptations",
			"guard.applied": "已应用",
			"guard.pending": "待确认",
			"guard.incidents": "最近事件",
			"guard.noPending": "暂无待确认的 adaptation。",
			"guard.disable": "Disable",
			"guard.enable": "Enable",
			"guard.confirmAdapt": "Confirm",
			"guard.confirmTitle.disable": "关闭硬件守卫",
			"guard.confirmTitle.enable": "开启硬件守卫",
			"guard.confirmDescription.disable": "关闭后，新的 shell 与新进程不再执行资源上限（准入门、看门狗、shell 序言与沙箱包装全部放行）。已有持久 shell 保留启动时继承的 ulimit；关闭只影响新的 shell 与进程。",
			"guard.confirmDescription.enable": "重新开启守卫：强制重新探测硬件、重新推导预算，并按 memoryCapPolicy 对现有后代进程分级重打地址空间上限。",
			"guard.reasonLabel": "原因",
			"guard.reasonPlaceholder": "可选：记录本次操作的原因",
			"guard.confirm": "确认",
			"guard.cancel": "取消",
			"guard.field.revision": "revision",
			"guard.field.updatedBy": "updatedBy",
			"guard.field.updatedAt": "updatedAt",
			"guard.field.state": "状态",
			"guard.field.free": "可用内存",
			"guard.field.load1": "load1",
			"guard.field.thresholds": "阈值",
			"guard.field.cpu": "CPU",
			"guard.field.memBudget": "内存预算",
			"guard.field.perCommandCap": "单命令地址空间上限",
			"guard.field.runaway": "内存失控阈值",
			"guard.field.maxBgJobs": "后台任务上限",
			"guard.field.nice": "nice",
			"guard.option.primary": "primary",
			"guard.option.alternative": "alternative",
			"adapt.rule.critical-transition-load": "连续严重压力",
			"adapt.reason.critical-transition-load": "过去 1 小时多次进入 critical；建议降低后台并发。",
			"adapt.rule.auto-kill-cooldown": "自动击杀冷却",
			"adapt.reason.auto-kill-cooldown": "发生了多次自动击杀；建议延长冷却时间，避免短时间反复误杀。",
			"adapt.rule.watchdog-error-limit": "看门狗异常保护",
			"adapt.reason.watchdog-error-limit": "短时间多次看门狗异常；建议关闭 critical 自动击杀并转人工处理。",
			"adapt.rule.critical-restart-reserve": "严重压力后重启余量",
			"adapt.reason.critical-restart-reserve": "重启前 15 分钟曾处于 critical；建议为宿主机多保留余量。",
			"adapt.rule.repeat-kill-watchlist": "重复击杀观察",
			"adapt.reason.repeat-kill-watchlist": "同一进程被多次自动击杀；建议加入观察名单，禁止自动永久排除。",
			"adapt.rule.host-unclean-boot": "宿主异常重启",
			"adapt.rule.unclean-boot-reserve": "宿主异常重启后保守余量",
			"adapt.reason.unclean-boot-reserve": "上次 guard 退出时没有 clean marker，且历史存在 critical / 自动击杀；建议为宿主机多留余量，降低再次过载风险。",
			"adapt.option.cpuReserve": "方案 A：为宿主机多留 CPU",
			"adapt.option.memBudget": "方案 B：收紧内存预算",
			"adapt.change.deltaCpuReserved": "让宿主机多保留 {n} 个 CPU 核心（后台/项目可用核心相应减少）",
			"adapt.change.deltaMemSafety": "把内存安全系数降低 {n}（更保守，给宿主机多留内存）",
			"adapt.change.deltaMaxBg": "把后台任务并发上限调整 {n}",
			"adapt.change.deltaKillCooldown": "把自动击杀冷却时间调整 {n} ms",

			"adapt.reason.host-unclean-boot": "上次 guard 退出时没有 clean marker，且存在 critical / 自动击杀历史；建议更保守的余量。",
			"adapt.rule.host-unclean-boot-review": "宿主异常重启复核",
			"adapt.reason.host-unclean-boot-review": "复核：上次宿主异常重启且存在 critical / 自动击杀历史，建议更保守的余量。",
			"adapt.rule.repeat-kill-watchlist-review": "重复击杀观察复核",
			"adapt.reason.repeat-kill-watchlist-review": "复核：同一进程被多次自动击杀，确认加入观察名单。",
			"adapt.option.primary": "方案 A",
			"adapt.option.alternative": "方案 B",
			"adapt.option.defer": "方案 C：暂不改动",
			"adapt.option.deferDesc": "只把这条待确认项标记为“已暂缓”，不修改任何配置；规则的冷却期结束后，如证据仍在，会重新提出。",
			"adapt.deferred": "已暂缓",
			"adapt.change.cpuReserved": "为宿主机多保留 {n} 个 CPU 核心",
			"adapt.change.memSafetyFrac": "把内存安全系数收紧到 {n}",
			"adapt.change.maxBackgroundJobs": "把后台任务上限调整为 {n}",
			"adapt.change.killCooldownMs": "把击杀冷却延长到 {n} ms",
			"adapt.change.autoKillOnCritical": "关闭 critical 自动击杀",
			"adapt.change.watchlist": "加入观察名单：{name}（不会自动永久排除）",

			"monitor.title": "资源台账",
			"monitor.current": "本会话",
			"monitor.entries": "监控项",
			"monitor.currentSection": "本会话监控任务",
			"monitor.otherSection": "其他监控会话",
			"monitor.noCurrent": "本会话当前没有占位、等待或孤儿任务。",
			"monitor.noOther": "没有其他会话正在占用资源。",
			"monitor.orphan": "孤儿进程",
			"monitor.unknownSource": "未知来源",
			"monitor.expand": "展开",
			"monitor.collapse": "收起",
			"monitor.restore": "恢复已隐藏",
			"projects.help": "左侧只显示显式登记到 resource-allocation 注册表的项目（seed 或“纳入项目”），不会按会话自动创建项目；会话只作为 run/queue/orphan 的 owner 出现。tasks 是期望任务，adopts 是 observe-only systemd unit，runs 是受管长任务，orphans 仅展示不清理。右侧是只读的占位与等待预测，标注项目、任务和 owner 链。",
			"projects.registryError": "项目注册表错误",
			"projects.empty": "没有注册的项目。",
			"projects.tasks": "任务",
			"projects.runs": "资源运行 / long-task runs",
			"projects.adopts": "接管的 units（仅观察）",
			"projects.orphans": "未纳管 / orphan（仅观察）",
			"projects.orphanDanger": "dsh-web cgroup — 会被重启杀掉",
			"projects.noOrphans": "没有 orphan 进程。",
			"projects.noTasks": "没有声明任务。",
			"projects.noRuns": "没有资源运行记录。",
			"projects.noAdopts": "没有接管的 units。",
			"projects.fleet": "fleet 投影",
			"projects.sessions": "会话摘要",
			"projects.sessionScope": "范围",
			"projects.allSessions": "全部会话",
			"projects.noCurrentSlots": "当前会话没有占位或等待任务；可切换到全部会话查看。",
			"projects.currentSession": "当前会话",
			"projects.otherSession": "其他会话",
			"projects.sessionsHelp": "按项目汇总会话 owning 的 runs、队列项、orphan 和最近活动；未知会话会明确标出。",
			"projects.noSessions": "没有可显示的会话记录。",
			"projects.sessionId": "会话 sessionId",
			"projects.sessionRuns": "运行",
			"projects.sessionQueue": "队列项",
			"projects.sessionOrphans": "孤儿进程",
			"projects.sessionLastSeen": "最近活动",
			"projects.slots": "占位与等待（只读预测）",
			"projects.readOnlyForecast": "占位/等待（只读预测，不会自动执行）",
			"projects.slotsHelp": "这一栏只做只读预测：谁正占着资源、谁还在排队。数据来自 resource-allocation 的 queue.json 与资源运行记录；不会在这里启动、停止或调整任何任务。每条都展示来源、状态、优先级、等待/运行时长和 owner 的 session/goal/job/run；未分配或未知的项目/任务/owner 会被明确标出。",
			"projects.occupied": "占位中",
			"projects.waiting": "等待中",
			"projects.noSlots": "当前没有占位或等待中的进程。",
			"projects.unassigned": "未分配",
			"projects.unaffiliated": "未登记",
			"projects.unknown": "未知",
			"projects.unknownProject": "未知项目",
			"projects.unknownTask": "未知任务",
			"projects.unregisteredProject": "未登记的项目",
			"projects.unregisteredTask": "未登记的任务",
			"projects.projectTask": "项目 / 任务",
			"projects.scheduler": "scheduler",
			"projects.ownerLabel": "归属",
			"projects.ownerSession": "session",
			"projects.ownerGoal": "goal",
			"projects.ownerJob": "job",
			"projects.ownerRun": "run",
			"projects.ownerUnassigned": "未分配（无 owner）",
			"projects.priority": "优先级",
			"projects.source": "来源",
			"projects.status": "状态",
			"projects.sourceScheduler": "scheduler 队列（只读）",
			"projects.sourceRun": "资源运行记录",
			"projects.sourceUnknown": "未知来源",
			"projects.queueRevision": "queue revision",
			"projects.lastDecision": "最近决策",
			"projects.noScheduler": "未接入 scheduler（未找到 queue.json）——下面只有资源运行记录。",
			"projects.waitTime": "等待/运行",
			"projects.allSlots": "合计",
			"projects.unassignedCount": "未分配 / 未知归属",
			"projects.pausedProjects": "已暂停监控项目",
			"projects.pauseMonitorConfirm": "取消监控后，该项目/任务会从默认项目树隐藏，但不会停止、删除或禁用任何任务。继续？",
			"projects.resumeMonitorConfirm": "恢复该项目的默认监控显示？",
			"projects.pauseMonitor": "取消监控",
			"projects.resumeMonitor": "恢复监控",
			"projects.pausedTasks": "已暂停监控任务",
			"projects.stopTask": "停止任务",
			"projects.stopTaskHint": "停止此受管任务并从本机监控列表隐藏；不会动 adopted unit",
			"projects.cancelQueued": "取消排队",
			"projects.cancelQueuedHint": "将队列项标记为 killed（仅队列记录；若已 linked run 请用停止任务）",
			"projects.stopConfirm": "确认停止该受管任务？这会 systemctl stop 它自己的 transient unit。",
			"projects.cancelConfirm": "确认取消该排队项？只会更新 queue.json，不会杀进程。",
			"projects.actionDone": "操作完成",
			"projects.hiddenMonitors": "已停止并隐藏",
			"projects.restoreMonitors": "恢复监控",
			"projects.hideMonitor": "取消监控",
			"projects.hideMonitorHint": "只隐藏此条显示，不停止进程",
			"projects.monitor": "监控",
			"projects.processLookup": "查找高占用进程",
			"projects.processLookupTitle": "高占用进程（只读）",
			"projects.processLookupHelp": "按需读取 /proc 两次采样，按 RSS 或 CPU 排序；不会停止任何进程。默认只查当前会话。",
			"projects.processSearch": "查找",
			"projects.processSearching": "读取中…",
			"projects.processSnapshot": "快照",
			"projects.noProcesses": "没有匹配的运行中进程。",
			"projects.scopeSession": "指定会话",
			"projects.scopeSystem": "全系统",
			"projects.sessionIdPlaceholder": "输入 session ID",
			"projects.useCurrentSession": "使用当前会话",
			"projects.processSessionRequired": "请先输入 session ID，或切换到全系统。",
			"projects.sortBy": "排序",
			"projects.sortRss": "内存 RSS",
			"projects.sortCpu": "CPU",
			"projects.discovered": "项目发现（可选）",
			"projects.discoveredSummary": "扫描摘要",
			"projects.discoveredExpand": "展开",
			"projects.discoveredCollapse": "收起",
			"projects.discoveredHelp": "扫描配置的项目根目录（project.json / .dsh-project.json）。只有写进 resource-allocation 注册表的项目才会成为项目树的一部分；这里列出尚未纳入的 manifest、缺少 manifest 的目录和校验失败的 manifest。",
			"projects.discoveredUnregistered": "未纳入",
			"projects.discoveredRegistered": "已登记",
			"projects.discoveredInvalid": "manifest 无效",
			"projects.discoveredMissing": "缺少 manifest",
			"projects.register": "纳入项目",
			"projects.registered": "已纳入",
			"projects.discoveredEmpty": "没有发现额外的项目目录。",
			"projects.discoveredDisabled": "未配置项目自动发现（discover.enabled + discover.roots）。",
			"projects.taskCount": "任务数",
			"projects.discoverErrors": "扫描错误",
			"common.loading": "加载中…",
			"common.error": "加载失败"
		};

		/** English dictionary (same key set). */
		const en = {
			"view.resources": "Resources",
			"view.notes": "Notes",
			"tab.guard": "Hardware",
			"tab.monitor": "Resource monitor",
			"tab.projects": "Projects",
			"guard.badge.active": "ENABLED",
			"guard.badge.disabled": "DISABLED",
			"guard.badge.dryrun": "DRY-RUN",
			"guard.badge.unknown": "UNKNOWN",
			"guard.refresh": "Refresh",
			"guard.snapshotAt": "Snapshot at",
			"guard.help": "Live guard state: pressure, memory/disk budget, hysteresis, pending adaptations and recent incidents. Disable/Enable is the master switch; Confirm acknowledges one adaptation.",
			"guard.cleanup": "Disk cleanup",
			"guard.cleanupDisabled": "Disk cleanup is off. Enable cleanupProbe in the system configuration first.",
			"guard.cleanupHelp": "Scan selected folders for large files and show a list first; nothing is deleted automatically. Select files, then move them to Trash or delete them permanently. System, virtualenv and cache directories are skipped.",
			"guard.cleanupScan": "Scan large files",
			"guard.cleanupSelectAll": "Select all",
			"guard.cleanupClear": "Clear selection",
			"guard.cleanupConfirm": "Clean selected",
			"guard.cleanupConfirmTrash": "Move to trash",
			"guard.cleanupConfirmDelete": "Delete permanently",
			"guard.cleanupEmpty": "No cleanup candidates found.",
			"guard.cleanupSkipped": "system/dependency dirs skipped",
			"guard.cleanupTrashDir": "Trash location",
			"guard.cleanupRoots": "Default scan locations",
			"guard.cleanupExtraRootsLabel": "Extra folders to scan (optional)",
			"guard.cleanupExtraRootsPlaceholder": "One folder per line, e.g. /path/to/large-output",
			"guard.cleanupExtraRootsHelp": "Optional. Extra folders here are stored only in this browser.",
			"guard.cleanupPermanentHint": "Permanent delete skips Trash and cannot be undone.",
			"guard.cleanupTrashSummary": "Trash",
			"guard.cleanupTrashView": "Inspect trash",
			"guard.cleanupTrashEmpty": "Empty trash",
			"guard.cleanupTrashConfirm": "Permanently empty Trash? This cannot be undone.",
			"guard.cleanupTrashDone": "Trash emptied",
			"guard.cleanupSelected": "selected",
			"guard.cleanupDaysAgo": "d ago",
			"guard.cleanupHoursAgo": "h ago",
			"guard.cleanupTrashUnknown": "not checked",
			"guard.cleanupFailedCount": "failed",
			"guard.controlSwitch": "Control switch",
			"guard.pressure": "Pressure",
			"guard.budget": "Budget",
			"guard.policy": "memoryCapPolicy",
			"guard.adaptations": "Adaptations",
			"guard.applied": "Applied",
			"guard.pending": "Pending",
			"guard.incidents": "Recent incidents",
			"guard.noPending": "No pending adaptations.",
			"guard.disable": "Disable",
			"guard.enable": "Enable",
			"guard.confirmAdapt": "Confirm",
			"guard.confirmTitle.disable": "Disable the hardware guard",
			"guard.confirmTitle.enable": "Enable the hardware guard",
			"guard.confirmDescription.disable": "After disabling, NEW shells and NEW processes run without resource enforcement (admission gate, watchdog, shell prologue and sandbox wrapper all pass through). Existing persistent shells keep the ulimits they inherited at spawn; disabling affects only new shells and processes.",
			"guard.confirmDescription.enable": "Re-enables the guard: forces a hardware re-probe and budget re-derivation, and re-applies graded address-space caps to existing descendants according to memoryCapPolicy.",
			"guard.reasonLabel": "Reason",
			"guard.reasonPlaceholder": "Optional: record why",
			"guard.confirm": "Confirm",
			"guard.cancel": "Cancel",
			"guard.field.revision": "revision",
			"guard.field.updatedBy": "updatedBy",
			"guard.field.updatedAt": "updatedAt",
			"guard.field.state": "State",
			"guard.field.free": "Free memory",
			"guard.field.load1": "load1",
			"guard.field.thresholds": "Thresholds",
			"guard.field.cpu": "CPU",
			"guard.field.memBudget": "Memory budget",
			"guard.field.perCommandCap": "Per-command address-space cap",
			"guard.field.runaway": "Memory runaway threshold",
			"guard.field.maxBgJobs": "Max background jobs",
			"guard.field.nice": "nice",
			"guard.option.primary": "primary",
			"guard.option.alternative": "alternative",
			"adapt.rule.critical-transition-load": "Repeated critical pressure",
			"adapt.reason.critical-transition-load": "Several critical transitions within one hour; lower background parallelism.",
			"adapt.rule.auto-kill-cooldown": "Auto-kill cooldown",
			"adapt.reason.auto-kill-cooldown": "Several auto-kill sweeps; lengthen the cooldown to avoid repeated kills.",
			"adapt.rule.watchdog-error-limit": "Watchdog error guard",
			"adapt.reason.watchdog-error-limit": "Repeated watchdog errors; stop automatic critical kills and require human review.",
			"adapt.rule.critical-restart-reserve": "Reserve after critical restart",
			"adapt.reason.critical-restart-reserve": "Critical pressure occurred shortly before the restart; reserve more headroom.",
			"adapt.rule.repeat-kill-watchlist": "Repeated-kill watchlist",
			"adapt.reason.repeat-kill-watchlist": "The same process was auto-killed repeatedly; observe it instead of permanently excluding it.",
			"adapt.rule.host-unclean-boot": "Unclean host boot",
			"adapt.rule.unclean-boot-reserve": "Reserve after unclean host boot",
			"adapt.reason.unclean-boot-reserve": "The previous guard run had no clean marker and critical/auto-kill history exists; reserve more host headroom to reduce repeat overload risk.",
			"adapt.option.cpuReserve": "Option A: reserve more CPU for the host",
			"adapt.option.memBudget": "Option B: tighten the memory budget",
			"adapt.change.deltaCpuReserved": "Reserve {n} more CPU core(s) for the host (less available to projects)",
			"adapt.change.deltaMemSafety": "Lower the memory safety fraction by {n} (more conservative)",
			"adapt.change.deltaMaxBg": "Adjust the background job limit by {n}",
			"adapt.change.deltaKillCooldown": "Adjust the auto-kill cooldown by {n} ms",

			"adapt.reason.host-unclean-boot": "The previous guard exit had no clean marker and critical/auto-kill history exists; propose more conservative headroom.",
			"adapt.rule.host-unclean-boot-review": "Unclean host boot review",
			"adapt.reason.host-unclean-boot-review": "Review: the previous boot was unclean with critical/auto-kill history; propose more conservative headroom.",
			"adapt.rule.repeat-kill-watchlist-review": "Repeated-kill watchlist review",
			"adapt.reason.repeat-kill-watchlist-review": "Review: confirm adding this repeatedly killed process to the watchlist.",
			"adapt.option.primary": "Option A",
			"adapt.option.alternative": "Option B",
			"adapt.option.defer": "Option C: keep unchanged for now",
			"adapt.option.deferDesc": "Marks this pending item as deferred without changing any configuration; the rule may re-propose after its cooldown if the evidence persists.",
			"adapt.deferred": "deferred",
			"adapt.change.cpuReserved": "Reserve {n} more CPU core(s) for the host",
			"adapt.change.memSafetyFrac": "Tighten the memory safety fraction to {n}",
			"adapt.change.maxBackgroundJobs": "Set the background job limit to {n}",
			"adapt.change.killCooldownMs": "Extend the kill cooldown to {n} ms",
			"adapt.change.autoKillOnCritical": "Disable automatic critical kills",
			"adapt.change.watchlist": "Add to watchlist: {name} (never auto-excluded permanently)",

			"monitor.title": "Resource ledger",
			"monitor.current": "Current session",
			"monitor.entries": "monitored entries",
			"monitor.currentSection": "Current-session tasks",
			"monitor.otherSection": "Other monitored sessions",
			"monitor.noCurrent": "No slot holders, waiting work or orphan processes in this session.",
			"monitor.noOther": "No other session is consuming resources.",
			"monitor.orphan": "Orphan process",
			"monitor.unknownSource": "Unknown source",
			"monitor.expand": "Expand",
			"monitor.collapse": "Collapse",
			"monitor.restore": "Restore hidden",
			"projects.help": "Left shows only projects explicitly registered in resource-allocation (via seed or “adopt discovered”); sessions never create projects automatically and appear only as run/queue/orphan owners. tasks are desired work, adopts are observe-only systemd units, runs are managed long tasks, and orphans are read-only. Right is a read-only forecast annotated with project, task and owner chain.",
			"projects.registryError": "Project registry error",
			"projects.empty": "No projects registered.",
			"projects.tasks": "Tasks",
			"projects.runs": "Resource runs / long-task runs",
			"projects.adopts": "Adopted units (observe only)",
			"projects.orphans": "Unmanaged / orphan (observe only)",
			"projects.orphanDanger": "dsh-web cgroup — killed by dsh-web restart",
			"projects.noOrphans": "No orphan processes.",
			"projects.noTasks": "No tasks declared.",
			"projects.noRuns": "No resource run records.",
			"projects.noAdopts": "No adopted units.",
			"projects.fleet": "Fleet projection",
			"projects.sessions": "Session summary",
			"projects.sessionScope": "Scope",
			"projects.allSessions": "All sessions",
			"projects.noCurrentSlots": "No slot holders or waiting work in this session; switch to all sessions.",
			"projects.currentSession": "This session",
			"projects.otherSession": "Other session",
			"projects.sessionsHelp": "Per-project sessions with owned runs, queue items, orphans and last activity; unknown sessions are marked explicitly.",
			"projects.noSessions": "No session records to show.",
			"projects.sessionId": "sessionId",
			"projects.sessionRuns": "Runs",
			"projects.sessionQueue": "Queue items",
			"projects.sessionOrphans": "Orphans",
			"projects.sessionLastSeen": "Last seen",
			"projects.slots": "Slot holders / waiting (read-only forecast)",
			"projects.readOnlyForecast": "Slot holders / waiting (read-only forecast; never executed automatically)",
			"projects.slotsHelp": "This column is a read-only forecast: who holds a resource right now and who is still waiting. Data comes from resource-allocation queue.json and the resource run registry; nothing here starts, stops or changes work. Every entry shows source, status, priority, wait/run time, and the owner session/goal/job/run; unassigned or unknown projects, tasks and owners are marked explicitly.",
			"projects.occupied": "Occupied",
			"projects.waiting": "Waiting",
			"projects.noSlots": "Nothing is occupied or waiting.",
			"projects.unassigned": "unassigned",
			"projects.unaffiliated": "unregistered",
			"projects.unknown": "unknown",
			"projects.unknownProject": "unknown project",
			"projects.unknownTask": "unknown task",
			"projects.unregisteredProject": "unregistered project",
			"projects.unregisteredTask": "unregistered task",
			"projects.projectTask": "project / task",
			"projects.scheduler": "scheduler",
			"projects.ownerLabel": "owner",
			"projects.ownerSession": "session",
			"projects.ownerGoal": "goal",
			"projects.ownerJob": "job",
			"projects.ownerRun": "run",
			"projects.ownerUnassigned": "unassigned (no owner)",
			"projects.priority": "priority",
			"projects.source": "source",
			"projects.status": "status",
			"projects.sourceScheduler": "scheduler queue (read-only)",
			"projects.sourceRun": "resource run registry",
			"projects.sourceUnknown": "unknown source",
			"projects.queueRevision": "queue revision",
			"projects.lastDecision": "last decision",
			"projects.noScheduler": "No scheduler wired in (no queue.json found) — only resource run records are shown.",
			"projects.waitTime": "waiting/running",
			"projects.allSlots": "total",
			"projects.unassignedCount": "unassigned / unknown",
			"projects.pausedProjects": "Paused-monitor projects",
			"projects.pauseMonitorConfirm": "Hide this project/task from the default tree? This never stops, deletes or disables work.",
			"projects.resumeMonitorConfirm": "Restore this project/task to the default monitoring view?",
			"projects.pauseMonitor": "Pause monitoring",
			"projects.resumeMonitor": "Resume monitoring",
			"projects.pausedTasks": "Paused-monitor tasks",
			"projects.stopTask": "Stop task",
			"projects.stopTaskHint": "Stop this managed task and hide it locally; adopted units are never touched",
			"projects.cancelQueued": "Cancel queued item",
			"projects.cancelQueuedHint": "Mark the queue item killed (queue record only; stop a linked run separately)",
			"projects.stopConfirm": "Stop this managed task? This runs systemctl stop on its own transient unit.",
			"projects.cancelConfirm": "Cancel this queued item? Only queue.json is updated; no process is killed.",
			"projects.actionDone": "Action completed",
			"projects.hiddenMonitors": "Stopped and hidden",
			"projects.restoreMonitors": "Restore monitoring",
			"projects.hideMonitor": "Hide",
			"projects.hideMonitorHint": "Hide only this row; the process keeps running",
			"projects.monitor": "Monitor",
			"projects.processLookup": "Find high-usage processes",
			"projects.processLookupTitle": "High-usage processes (read-only)",
			"projects.processLookupHelp": "Reads /proc twice on demand and ranks by RSS or CPU; it never stops anything. Defaults to this session.",
			"projects.processSearch": "Search",
			"projects.processSearching": "Reading…",
			"projects.processSnapshot": "Snapshot",
			"projects.noProcesses": "No matching running processes.",
			"projects.scopeSession": "Session",
			"projects.scopeSystem": "System",
			"projects.sessionIdPlaceholder": "Enter a session ID",
			"projects.useCurrentSession": "Use current session",
			"projects.processSessionRequired": "Enter a session ID or switch to System.",
			"projects.sortBy": "Sort",
			"projects.sortRss": "RSS memory",
			"projects.sortCpu": "CPU",
			"projects.discovered": "Project discovery (optional)",
			"projects.discoveredSummary": "Scan summary",
			"projects.discoveredExpand": "Expand",
			"projects.discoveredCollapse": "Collapse",
			"projects.discoveredHelp": "Scans the configured project roots for project.json / .dsh-project.json. Only manifests written into the resource-allocation registry become part of the project tree; this lists the ones not adopted yet, directories with no manifest, and manifests that fail validation.",
			"projects.discoveredUnregistered": "not adopted",
			"projects.discoveredRegistered": "registered",
			"projects.discoveredInvalid": "invalid manifest",
			"projects.discoveredMissing": "no manifest",
			"projects.register": "Adopt project",
			"projects.registered": "adopted",
			"projects.discoveredEmpty": "No extra project directories found.",
			"projects.discoveredDisabled": "Project auto-discovery is not configured (discover.enabled + discover.roots).",
			"projects.taskCount": "tasks",
			"projects.discoverErrors": "Scan errors",
			"common.loading": "Loading…",
			"common.error": "Load failed"
		};

		// ── styles (theme tokens only, no hardcoded palette) ─────────────────

		const rootStyle = { padding: 12, height: "100%", boxSizing: "border-box", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 };
		const tabBarStyle = { display: "flex", gap: 8, alignItems: "center", flex: "none" };
		const cardStyle = { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: 10, background: "var(--dsw-alias-bg-base)" };
		const cardTitleStyle = { fontSize: 13, fontWeight: 600, margin: "0 0 6px", color: "var(--dsw-alias-label-primary)" };
		const rowStyle = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
		const fieldGridStyle = { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "2px 12px", fontSize: 12 };
		const fieldLabelStyle = { color: "var(--dsw-alias-label-tertiary)" };
		const fieldValueStyle = { color: "var(--dsw-alias-label-primary)", wordBreak: "break-all" };
		const mutedStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 };
		const errorStyle = { color: "var(--dsw-alias-state-error-primary)", fontSize: 12, whiteSpace: "pre-wrap" };
		const successStyle = { color: "var(--dsw-alias-state-success-primary)", fontSize: 12, whiteSpace: "pre-wrap" };
		const tableStyle = { borderCollapse: "collapse", width: "100%", fontSize: 12 };
		const cellStyle = { borderBottom: "1px solid var(--dsw-alias-border-l2)", padding: "3px 6px", textAlign: "left", verticalAlign: "top" };
		const dangerStyle = { color: "var(--dsw-alias-state-error-primary)", fontWeight: 600 };
		const readOnlyNoticeStyle = { border: "1px solid var(--dsw-alias-border-l2)", borderLeft: "3px solid var(--dsw-alias-state-warn-primary)", borderRadius: 6, padding: "6px 8px", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)", fontSize: 12, fontWeight: 600 };
		const badgeStyle = { display: "inline-flex", alignItems: "center", border: "1px solid", borderRadius: 999, padding: "0 8px", fontSize: 12, lineHeight: "18px", fontWeight: 600 };
		const ghostButtonStyle = {
			background: "0 0",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			color: "var(--dsw-alias-label-primary)",
			cursor: "pointer",
			padding: "2px 10px",
			fontSize: 12,
			display: "inline-flex",
			alignItems: "center",
			gap: 4
		};
		const inputStyle = {
			background: "var(--dsw-alias-button-elevated-fill)",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			color: "var(--dsw-alias-label-primary)",
			padding: "3px 8px",
			fontSize: 12,
			width: "100%",
			boxSizing: "border-box"
		};

		// ── helpers ──────────────────────────────────────────────────────────

		function fetchJson(url) {
			return fetch(url).then(async (response) => {
				const text = await response.text();
				let data = null;
				if (text.trim() !== "") {
					try {
						data = JSON.parse(text);
					} catch {
						data = null;
					}
				}
				if (!response.ok || data === null) {
					const message = (data !== null && typeof data === "object" && typeof data.error === "string")
						? data.error
						: `HTTP ${response.status}`;
					throw new Error(message);
				}
				return data;
			});
		}

		function postHardware(payload) {
			return postJson("/resources/hardware", payload);
		}

		function postJson(url, payload) {
			return fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-resource-action": "1" },
				body: JSON.stringify(payload)
			}).then(async (response) => {
				const text = await response.text();
				let data = null;
				if (text.trim() !== "") {
					try {
						data = JSON.parse(text);
					} catch {
						data = null;
					}
				}
				return { status: response.status, ok: response.ok, data };
			});
		}

		function formatBytes(bytes) {
			if (!Number.isFinite(bytes) || bytes === null || bytes === undefined) return "?";
			if (bytes < 1024) return `${bytes} B`;
			if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
			if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
			return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
		}

		function formatDuration(ms) {
			if (!Number.isFinite(ms) || ms < 0) return "?";
			const total = Math.floor(ms / 1000);
			const h = Math.floor(total / 3600);
			const m = Math.floor((total % 3600) / 60);
			const s = total % 60;
			return `${h}h${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`;
		}

		function formatOwner(t, owner, fallback) {
			const source = owner !== null && typeof owner === "object" ? owner : {};
			const extra = fallback !== null && typeof fallback === "object" ? fallback : {};
			const read = (...values) => values.find((value) => value !== null && value !== undefined && value !== "");
			const sessionId = read(
				typeof owner === "string" ? owner : undefined,
				source.sessionId,
				extra.sessionId,
				extra.ownerSessionId,
				source.session?.id,
				extra.session?.id
			);
			const goalId = read(source.goalId, extra.goalId, extra.ownerGoalId, source.goal?.id, extra.goal?.id);
			const jobId = read(source.jobId, extra.jobId, extra.ownerJobId, source.job?.id, extra.job?.id);
			const runId = read(
				source.runId,
				extra.runId,
				extra.ownerRunId,
				source.run?.id,
				extra.run?.id,
				extra.source !== "scheduler" ? extra.id : undefined
			);
			const parts = [];
			if (sessionId !== undefined) parts.push(`${t("projects.ownerSession")} ${sessionId}`);
			if (goalId !== undefined) parts.push(`${t("projects.ownerGoal")} ${goalId}`);
			if (jobId !== undefined) parts.push(`${t("projects.ownerJob")} ${jobId}`);
			if (runId !== undefined) parts.push(`${t("projects.ownerRun")} ${runId}`);
			return parts.length > 0 ? parts.join(" · ") : null;
		}

		function formatSource(t, source) {
			if (source === null || source === undefined || source === "") return t("projects.sourceUnknown");
			const normalized = String(source).toLowerCase();
			if (normalized === "scheduler" || normalized === "queue" || normalized === "resource-scheduler") return t("projects.sourceScheduler");
			if (normalized === "run" || normalized === "resource-run" || normalized === "resource_run" || normalized.endsWith("-run")) return t("projects.sourceRun");
			return String(source);
		}

		function formatAffiliation(t, entry) {
			const source = entry !== null && typeof entry === "object" ? entry : {};
			const projectId = source.projectId ?? source.project?.id ?? null;
			const taskId = source.taskId ?? source.task?.id ?? null;
			const hasProjectId = projectId !== null && projectId !== "";
			const hasTaskId = taskId !== null && taskId !== "";
			const projectKnown = source.projectKnown !== false && hasProjectId;
			const taskKnown = source.taskKnown !== false && hasTaskId;
			if (source.unassigned === true || (!hasProjectId && !hasTaskId)) {
				return { text: t("projects.unassigned"), broken: true, unassigned: true };
			}
			let projectText;
			if (!hasProjectId) projectText = t("projects.unknownProject");
			else if (source.projectKnown === false) projectText = `${t("projects.unregisteredProject")} ${projectId}`;
			else projectText = source.projectName ?? (typeof source.project === "string" ? source.project : null) ?? projectId;
			let taskText;
			if (!hasTaskId) taskText = t("projects.unknownTask");
			else if (source.taskKnown === false) taskText = `${t("projects.unregisteredTask")} ${taskId}`;
			else taskText = taskId;
			return { text: `${projectText} / ${taskText}`, broken: !projectKnown || !taskKnown, unassigned: false };
		}

		function sessionCount(value) {
			if (typeof value === "number" && Number.isFinite(value)) return value;
			if (Array.isArray(value)) return value.length;
			if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
			if (value !== null && typeof value === "object") {
				for (const key of ["count", "total", "length", "items"]) {
					if (key in value) return sessionCount(value[key]);
				}
				return Object.keys(value).length;
			}
			return null;
		}

		function sessionMetric(session, keys) {
			for (const key of keys) {
				if (session !== null && typeof session === "object" && key in session) {
					const count = sessionCount(session[key]);
					if (count !== null) return count;
				}
			}
			return "—";
		}

		function normalizeSessionEntries(value) {
			if (Array.isArray(value)) return value.filter((entry) => entry !== null && typeof entry === "object");
			if (value !== null && typeof value === "object") {
				if (Array.isArray(value.sessions)) return value.sessions.filter((entry) => entry !== null && typeof entry === "object");
				if ("sessionId" in value || "session" in value || "lastSeen" in value || "runCount" in value || "queueCount" in value) return [value];
				return Object.entries(value).map(([sessionId, entry]) => (
					entry !== null && typeof entry === "object" ? { sessionId, ...entry } : { sessionId, runs: entry }
				));
			}
			return [];
		}

		function scopedSessions(globalSessions, projectId) {
			if (Array.isArray(globalSessions)) {
				const tagged = globalSessions.filter((entry) => entry?.projectId === projectId || entry?.project?.id === projectId);
				if (tagged.length > 0) return normalizeSessionEntries(tagged);
				const untagged = globalSessions.filter((entry) => entry?.projectId === undefined && entry?.project?.id === undefined);
				return normalizeSessionEntries(untagged);
			}
			if (globalSessions !== null && typeof globalSessions === "object") {
				const direct = globalSessions[projectId];
				if (direct !== undefined) return normalizeSessionEntries(direct);
				const candidates = [globalSessions.projects?.[projectId], globalSessions.byProject?.[projectId], globalSessions[`project:${projectId}`]];
				for (const candidate of candidates) {
					if (candidate !== undefined) return normalizeSessionEntries(candidate);
				}
				if (Array.isArray(globalSessions.sessions)) return scopedSessions(globalSessions.sessions, projectId);
			}
			return [];
		}

		function waitingEntryList(waiting) {
			const fromValue = (value) => {
				if (Array.isArray(value)) return value;
				if (value !== null && typeof value === "object" && Array.isArray(value.entries)) return value.entries;
				return [];
			};
			const primary = fromValue(waiting?.entries ?? waiting?.items ?? waiting?.slots);
			const extras = fromValue(waiting?.unassigned).map((entry) => (
				entry !== null && typeof entry === "object" ? { ...entry, unassigned: true } : entry
			));
			const seen = new Set();
			return [...primary, ...extras].filter((entry) => {
				if (entry === null || typeof entry !== "object") return false;
				const key = [entry.source, entry.id, entry.owner?.sessionId, entry.projectId, entry.taskId].join("|");
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		}

		function deriveProjectSessions(projectRecord, waitingEntries) {
			const project = projectRecord?.project ?? {};
			const projectId = project.id ?? projectRecord?.id ?? null;
			const projectName = project.name ?? null;
			const sessions = new Map();
			const ensure = (sessionId) => {
				if (sessionId === null || sessionId === undefined || sessionId === "") return null;
				if (!sessions.has(sessionId)) sessions.set(sessionId, { sessionId, runs: 0, queueItems: 0, orphans: 0, lastSeen: null });
				return sessions.get(sessionId);
			};
			const touch = (session, value) => {
				if (session === null || !Number.isFinite(value) || value <= 0) return;
				session.lastSeen = session.lastSeen === null ? value : Math.max(session.lastSeen, value);
			};
			for (const run of Array.isArray(projectRecord?.runs) ? projectRecord.runs : []) {
				const session = ensure(run?.owner?.sessionId ?? run?.sessionId);
				if (session === null) continue;
				session.runs += 1;
				touch(session, run?.finishedAt ?? run?.startedAt ?? run?.updatedAt);
			}
			for (const orphan of Array.isArray(projectRecord?.orphans) ? projectRecord.orphans : []) {
				const session = ensure(orphan?.sessionId ?? orphan?.owner?.sessionId);
				if (session === null) continue;
				session.orphans += 1;
				touch(session, orphan?.lastSeen ?? orphan?.startedAt ?? orphan?.updatedAt);
			}
			for (const entry of Array.isArray(waitingEntries) ? waitingEntries : []) {
				const entryProjectId = entry?.projectId ?? entry?.project?.id ?? null;
				const entryProjectName = entry?.projectName ?? (typeof entry?.project === "string" ? entry.project : null);
				const matchesProject = entryProjectId !== null
					? entryProjectId === projectId
					: entryProjectName !== null && entryProjectName === projectName;
				if (!matchesProject) continue;
				const session = ensure(entry?.owner?.sessionId ?? entry?.sessionId);
				if (session === null) continue;
				session.queueItems += 1;
				touch(session, entry?.submittedAt ?? entry?.startedAt ?? entry?.updatedAt);
			}
			return [...sessions.values()];
		}

		function projectSessionSummary(projectRecord, globalSessions, waitingEntries) {
			const projectId = projectRecord?.project?.id ?? projectRecord?.id ?? null;
			const explicit = normalizeSessionEntries(projectRecord?.sessions);
			const scoped = explicit.length > 0 ? explicit : scopedSessions(globalSessions, projectId);
			const sessions = scoped.length > 0 ? scoped : deriveProjectSessions(projectRecord, waitingEntries);
			return sessions.map((session) => ({
				...session,
				sessionId: session.sessionId ?? session.id ?? session.session ?? null,
				runs: session.runs ?? session.runCount ?? session.runsCount,
				queueItems: session.queueItems ?? session.queueCount ?? session.waiting ?? session.waitingCount,
				orphans: session.orphans ?? session.orphanCount ?? session.orphansCount,
				lastSeen: session.lastSeen ?? session.lastActivity ?? session.updatedAt
			}));
		}

		function formatArgv(argv, max = 120) {
			const text = (Array.isArray(argv) ? argv : []).join(" ");
			return text.length > max ? `${text.slice(0, max - 1)}…` : text;
		}

		function formatTime(value) {
			if (value === null || value === undefined || value === "") return "—";
			let timestamp = NaN;
			if (typeof value === "number") timestamp = value;
			else if (typeof value === "string") {
				const trimmed = value.trim();
				timestamp = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
			}
			if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
			try {
				return new Date(timestamp).toISOString();
			} catch {
				return "—";
			}
		}

		function adaptationRuleLabel(t, rule) {
			if (typeof rule !== "string" || rule.length === 0) return "?";
			const key = `adapt.rule.${rule}`;
			const value = t(key);
			return value === key ? rule : value;
		}

		function adaptationReason(t, rule, fallback) {
			if (typeof rule === "string" && rule.length > 0) {
				const key = `adapt.reason.${rule}`;
				const value = t(key);
				if (value !== key) return value;
			}
			return fallback ?? "";
		}

		function changeDescription(t, change) {
			const field = typeof change?.field === "string" ? change.field : "";
			const op = change?.op;
			if (op === "delta") {
				const delta = change?.delta;
				if (field === "cpuReservedCores") return t("adapt.change.deltaCpuReserved").replace("{n}", String(delta));
				if (field === "memSafetyFrac") return t("adapt.change.deltaMemSafety").replace("{n}", String(Math.abs(delta)));
				if (field === "maxBackgroundJobs") return t("adapt.change.deltaMaxBg").replace("{n}", String(delta));
				if (field === "killCooldownMs") return t("adapt.change.deltaKillCooldown").replace("{n}", String(delta));
				return `${field} += ${delta}`;
			}
			if (op === "set") {
				if (field === "autoKillOnCritical") return t("adapt.change.autoKillOnCritical");
				return `${field} = ${JSON.stringify(change?.value)}`;
			}
			const after = change?.after;
			if (field === "budget.cpuReservedCores") return t("adapt.change.cpuReserved").replace("{n}", String(after ?? ""));
			if (field === "budget.memSafetyFrac") return t("adapt.change.memSafetyFrac").replace("{n}", String(after ?? ""));
			if (field === "budget.maxBackgroundJobs") return t("adapt.change.maxBackgroundJobs").replace("{n}", String(after ?? ""));
			if (field === "enforcement.killCooldownMs") return t("adapt.change.killCooldownMs").replace("{n}", String(after ?? ""));
			if (field === "enforcement.autoKillOnCritical") return t("adapt.change.autoKillOnCritical");
			if (field.startsWith("watchlist.")) return t("adapt.change.watchlist").replace("{name}", String(after ?? ""));
			return `${field}: ${JSON.stringify(change?.before)} → ${JSON.stringify(after)}`;
		}

		/** Option C label for the "暂不改动 / keep unchanged" choice. */
		const DEFER_OPTION = "defer";

		function optionTitle(t, rule, label) {
			if (label === "primary") return t("adapt.option.cpuReserve");
			if (label === "alternative") return t("adapt.option.memBudget");
			if (label === DEFER_OPTION) return t("adapt.option.defer");
			return label;
		}

		function optionDescription(t, option) {
			if (option?.label === DEFER_OPTION) return t("adapt.option.deferDesc");
			const changes = Array.isArray(option?.changes) ? option.changes : [];
			if (changes.length > 0) return changes.map((change) => changeDescription(t, change)).join("；");
			return option?.description ?? "";
		}

		/** 15s auto-refresh loader: initial fetch + interval; errors stay visible. */
		function useAutoRefresh(load) {
			const [state, setState] = useState({ data: null, error: null, loading: true });
			const loadRef = useRef(load);
			loadRef.current = load;
			const run = useCallback(() => {
				let alive = true;
				setState((previous) => ({ ...previous, loading: previous.data === null }));
				loadRef.current().then((data) => {
					if (alive) setState({ data, error: null, loading: false });
				}).catch((error) => {
					if (alive) setState({ data: null, error: String(error?.message ?? error), loading: false });
				});
				return () => {
					alive = false;
				};
			}, []);
			useEffect(() => {
				const cancel = run();
				const timer = setInterval(run, REFRESH_MS);
				return () => {
					cancel();
					clearInterval(timer);
				};
			}, [run]);
			return { ...state, reload: run };
		}

		function readHiddenMonitors() {
			try {
				const parsed = JSON.parse(localStorage.getItem(HIDDEN_MONITORS_KEY) ?? "[]");
				return new Set(Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : []);
			} catch {
				return new Set();
			}
		}

		function useHiddenMonitors() {
			const [hidden, setHidden] = useState(() => readHiddenMonitors());
			const safeHidden = hidden instanceof Set ? hidden : readHiddenMonitors();
			const hide = (key) => setHidden((current) => {
				const next = new Set(current instanceof Set ? current : []);
				next.add(key);
				try { localStorage.setItem(HIDDEN_MONITORS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
				return next;
			});
			const restoreAll = () => setHidden(() => {
				try { localStorage.setItem(HIDDEN_MONITORS_KEY, "[]"); } catch { /* ignore */ }
				return new Set();
			});
			return { hidden: safeHidden, hide, restoreAll };
		}

		function runMonitorKey(projectId, runId) {
			return `run:${String(projectId ?? "?")}:${String(runId ?? "?")}`;
		}

		function slotMonitorKey(entry) {
			return `slot:${String(entry?.source ?? "?")}:${String(entry?.id ?? entry?.unit ?? entry?.pid ?? "?")}:${String(entry?.owner?.sessionId ?? entry?.sessionId ?? "")}`;
		}

		// ── small shared pieces ─────────────────────────────────────────────

		function Field({ label, value }) {
			return jsxs(Fragment, {
				children: [
					jsx("dt", { style: fieldLabelStyle, children: label }),
					jsx("dd", { style: { ...fieldValueStyle, margin: 0 }, children: value === undefined || value === null || value === "" ? "—" : String(value) })
				]
			});
		}

		function Card({ title, children }) {
			return jsxs("section", {
				style: cardStyle,
				children: [
					jsx("h3", { style: cardTitleStyle, children: title }),
					children
				]
			});
		}

		function Help({ notes, text }) {
			if (notes !== true || !text) return null;
			return jsx("div", {
				style: { ...mutedStyle, background: "var(--dsw-alias-bg-layer-2)", borderRadius: 6, padding: "8px 10px", lineHeight: 1.5 },
				children: text
			});
		}

		function StatusBadge({ enforcement, t }) {
			const specs = {
				active: { label: "guard.badge.active", color: "var(--dsw-alias-state-success-primary)" },
				disabled: { label: "guard.badge.disabled", color: "var(--dsw-alias-state-error-primary)" },
				"dry-run": { label: "guard.badge.dryrun", color: "var(--dsw-alias-state-warn-primary)" },
				unknown: { label: "guard.badge.unknown", color: "var(--dsw-alias-label-tertiary)" }
			};
			const spec = specs[enforcement] ?? specs.unknown;
			return jsx("span", { style: { ...badgeStyle, borderColor: spec.color, color: spec.color }, children: t(spec.label) });
		}

		// ── Guard tab ───────────────────────────────────────────────────────

		function PendingAdaptation({ entry, t, onConfirm }) {
			const options = Array.isArray(entry.options) && entry.options.length > 0 ? entry.options : [{ label: "primary", description: null, changes: [] }];
			// Option C (暂不改动) is offered only when the proposal really has
			// A/B alternatives; review-only entries are already "acknowledge".
			const choices = options.length > 1 ? [...options, { label: DEFER_OPTION, description: null, changes: [] }] : options;
			const [option, setOption] = useState(options[0]?.label ?? "primary");
			const choose = (label) => setOption(label);
			return jsxs("li", {
				style: { margin: "6px 0", fontSize: 12, display: "flex", flexDirection: "column", gap: 4 },
				children: [
					jsxs("div", {
						style: rowStyle,
						children: [
							jsx("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary)" }, children: adaptationRuleLabel(t, entry.rule) }),
							entry.needsHuman === true
								? jsx("span", { style: mutedStyle, children: "NEEDS_HUMAN" })
								: null
						]
					}),
					jsx("div", { style: { color: "var(--dsw-alias-label-secondary)" }, children: adaptationReason(t, entry.rule, entry.reason) }),
					entry.cap !== undefined && entry.cap !== null
						? jsx("div", { style: mutedStyle, children: `cap: ${entry.cap}` })
						: null,
					options.length > 1
						? jsxs("div", {
							style: { display: "flex", flexDirection: "column", gap: 3 },
							children: [
								jsxs("div", {
									style: rowStyle,
									children: choices.map((candidate) => jsx(primitives.Pill, {
										active: option === candidate.label,
										onClick: () => choose(candidate.label),
										children: optionTitle(t, entry.rule, candidate.label)
									}, candidate.label))
								}),
								jsx("div", { style: mutedStyle, children: optionDescription(t, choices.find((candidate) => candidate.label === option)) })
							]
						})
						: jsx("div", { style: mutedStyle, children: optionDescription(t, options[0]) }),
					jsx("div", {
						style: rowStyle,
						children: jsx("button", {
							type: "button",
							style: ghostButtonStyle,
							onClick: () => onConfirm(entry.id, option),
							children: jsxs(Fragment, {
								children: [
									option === DEFER_OPTION
										? jsx(IconFolderClose, { size: 14 })
										: jsx(IconCheck, { size: 14 }),
									jsx("span", { children: option === DEFER_OPTION ? t("adapt.option.defer") : t("guard.confirmAdapt") })
								]
							})
						})
					})
				]
			});
		}

		function CleanupCard({ t, cleanup, reload }) {
			const [plan, setPlan] = useState(null);
			const [selected, setSelected] = useState([]);
			const [busy, setBusy] = useState(false);
			const [feedback, setFeedback] = useState(null);
			const [trash, setTrash] = useState(null);
			const [trashBusy, setTrashBusy] = useState(false);
			const [extraRootsText, setExtraRootsText] = useState(() => {
				try {
					const parsed = JSON.parse(globalThis.localStorage?.getItem(CLEANUP_EXTRA_ROOTS_KEY) ?? "[]");
					return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string").join("\n") : "";
				} catch {
					return "";
				}
			});
			const effectivePlan = plan ?? cleanup?.lastPlan ?? null;
			const candidates = Array.isArray(effectivePlan?.candidates) ? effectivePlan.candidates : [];

			const scan = () => {
				const extraRoots = extraRootsText.split(/\r?\n|,/).map((value) => value.trim()).filter((value) => value.length > 0);
				const roots = [...new Set([...(Array.isArray(cleanup?.roots) ? cleanup.roots : []), ...extraRoots])];
				try { globalThis.localStorage?.setItem(CLEANUP_EXTRA_ROOTS_KEY, JSON.stringify(extraRoots)); } catch { /* local preference only */ }
				setBusy(true); setFeedback(null);
				postHardware({ action: "cleanup-scan", ...(roots.length > 0 ? { roots } : {}) }).then(({ status, ok, data }) => {
					setBusy(false);
					if (ok && data?.plan) { setPlan(data.plan); setSelected([]); }
					else setFeedback({ ok: false, text: data?.error ?? `HTTP ${status}` });
				}).catch((error) => { setBusy(false); setFeedback({ ok: false, text: String(error?.message ?? error) }); });
			};
			const toggle = (path) => setSelected((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
			const confirm = (mode) => {
				if (effectivePlan === null || selected.length === 0) { setFeedback({ ok: false, text: t("guard.cleanupEmpty") }); return; }
				const question = mode === "trash"
					? `Move ${selected.length} selected file(s) to the trash directory?`
					: `Permanently delete ${selected.length} selected file(s)? This cannot be undone.`;
				if (typeof globalThis.confirm === "function" && globalThis.confirm(question) !== true) return;
				setBusy(true); setFeedback(null);
				postHardware({ action: "cleanup-confirm", planId: effectivePlan.id, paths: selected, mode }).then(({ status, ok, data }) => {
					setBusy(false);
					if (ok) {
						const moved = data.deleted?.length ?? 0;
						const failed = data.failed?.length ?? 0;
						const where = data.mode === "trash" && data.trashDir ? ` → ${t("guard.cleanupTrashDir")} ${data.trashDir}` : "";
						setFeedback({ ok: true, text: `${data.mode === "trash" ? t("guard.cleanupConfirmTrash") : t("guard.cleanupConfirmDelete")}: ${moved}${where}${failed > 0 ? ` · ${t("guard.cleanupFailedCount")} ${failed}` : ""}` });
						setPlan(null); setSelected([]); setTrash(null); reload();
					}
					else setFeedback({ ok: false, text: data?.error ?? `HTTP ${status}` });
				}).catch((error) => { setBusy(false); setFeedback({ ok: false, text: String(error?.message ?? error) }); });
			};
			const loadTrash = () => {
				setTrashBusy(true); setFeedback(null);
				postHardware({ action: "cleanup-trash", mode: "summary" }).then(({ status, ok, data }) => {
					setTrashBusy(false);
					if (ok) setTrash(data);
					else setFeedback({ ok: false, text: data?.error ?? `HTTP ${status}` });
				}).catch((error) => { setTrashBusy(false); setFeedback({ ok: false, text: String(error?.message ?? error) }); });
			};
			const emptyTrash = () => {
				if (typeof globalThis.confirm === "function" && globalThis.confirm(t("guard.cleanupTrashConfirm")) !== true) return;
				setTrashBusy(true); setFeedback(null);
				postHardware({ action: "cleanup-trash", mode: "empty" }).then(({ status, ok, data }) => {
					setTrashBusy(false);
					if (ok) { setTrash(data); setFeedback({ ok: true, text: `${t("guard.cleanupTrashDone")}: ${data.removed ?? 0} / ${formatBytes(data.bytesFreed ?? 0)}` }); }
					else setFeedback({ ok: false, text: data?.error ?? `HTTP ${status}` });
				}).catch((error) => { setTrashBusy(false); setFeedback({ ok: false, text: String(error?.message ?? error) }); });
			};

if (cleanup?.enabled !== true) {
return jsx(Card, { title: t("guard.cleanup"), children: jsx("p", { style: mutedStyle, children: t("guard.cleanupDisabled") }) });
}
const roots = Array.isArray(cleanup?.roots) ? cleanup.roots : [];
const panelStyle = { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, padding: 10, background: "var(--dsw-alias-bg-base)" };
const buttonBase = { ...ghostButtonStyle, borderRadius: 8, padding: "5px 10px", fontSize: 12 };
const primaryButton = { ...buttonBase, borderColor: "var(--dsw-alias-state-business-primary)", color: "var(--dsw-alias-state-business-primary)", fontWeight: 600 };
const dangerButton = { ...buttonBase, borderColor: "var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-state-error-primary)" };
const ageLabel = (ms) => {
const hours = Math.max(0, Math.floor((ms ?? 0) / 3600000));
return hours >= 24 ? `${Math.floor(hours / 24)}${t("guard.cleanupDaysAgo")}` : `${hours}${t("guard.cleanupHoursAgo")}`;
};
return jsx(Card, {
title: t("guard.cleanup"),
children: jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 10 }, children: [
jsx("p", { style: { ...mutedStyle, lineHeight: 1.7 }, children: t("guard.cleanupHelp") }),
jsxs("div", { style: panelStyle, children: [
jsx("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-primary)", marginBottom: 6 }, children: t("guard.cleanupRoots") }),
jsxs("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 }, children: roots.length === 0
? jsx("span", { style: mutedStyle, children: "—" })
: roots.map((root) => jsx("span", { style: { ...badgeStyle, fontFamily: "monospace" }, children: root }, root)) }),
jsx("p", { style: { ...mutedStyle, margin: "10px 0 4px" }, children: t("guard.cleanupExtraRootsLabel") }),
jsx("textarea", {
rows: 2,
value: extraRootsText,
onChange: (event) => setExtraRootsText(event.target.value),
placeholder: t("guard.cleanupExtraRootsPlaceholder"),
style: { width: "100%", boxSizing: "border-box", fontSize: 12, fontFamily: "monospace", padding: 8, borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-secondary)", color: "var(--dsw-alias-label-primary)", resize: "vertical" }
}),
jsx("p", { style: { ...mutedStyle, margin: "4px 0 0" }, children: t("guard.cleanupExtraRootsHelp") })
] }),
jsxs("div", { style: { ...rowStyle, flexWrap: "wrap", gap: 8 }, children: [
jsx("button", { type: "button", style: primaryButton, disabled: busy, onClick: scan, children: busy ? t("common.loading") : t("guard.cleanupScan") }),
jsx("button", { type: "button", style: buttonBase, disabled: busy || candidates.length === 0, onClick: () => setSelected(candidates.map((item) => item.path)), children: t("guard.cleanupSelectAll") }),
jsx("button", { type: "button", style: buttonBase, disabled: busy || selected.length === 0, onClick: () => setSelected([]), children: t("guard.cleanupClear") })
] }),
jsxs("div", { style: { ...rowStyle, flexWrap: "wrap", gap: 8, paddingTop: 2 }, children: [
jsx("button", { type: "button", style: buttonBase, disabled: busy || selected.length === 0, onClick: () => confirm("trash"), children: `${t("guard.cleanupConfirmTrash")} (${selected.length})` }),
jsx("button", { type: "button", style: dangerButton, disabled: busy || selected.length === 0, onClick: () => confirm("permanent"), children: `${t("guard.cleanupConfirmDelete")} (${selected.length})` }),
jsx("span", { style: { flex: 1 } }),
jsx("span", { style: mutedStyle, children: `${t("guard.cleanupSelected")} ${selected.length}` })
] }),
jsx("p", { style: { ...mutedStyle, lineHeight: 1.6 }, children: `${t("guard.cleanupSkipped")} ${effectivePlan?.skippedDirs ?? 0} · ${t("guard.cleanupTrashDir")}: ${cleanup?.trashDir ?? "—"}` }),
jsxs("div", { style: { ...panelStyle, borderLeft: "3px solid var(--dsw-alias-state-error-primary)" }, children: [
jsx("div", { style: { ...dangerStyle, fontSize: 12, marginBottom: 6 }, children: t("guard.cleanupPermanentHint") }),
jsxs("div", { style: { ...rowStyle, flexWrap: "wrap", gap: 8 }, children: [
jsx("span", { style: { ...mutedStyle, fontFamily: "monospace" }, children: `${t("guard.cleanupTrashSummary")}: ${trash === null ? t("guard.cleanupTrashUnknown") : `${trash.plans ?? 0} · ${formatBytes(trash.bytes ?? 0)}`}` }),
jsx("span", { style: { flex: 1 } }),
jsx("button", { type: "button", style: buttonBase, disabled: trashBusy, onClick: loadTrash, children: t("guard.cleanupTrashView") }),
jsx("button", { type: "button", style: dangerButton, disabled: trashBusy || trash === null || (trash.plans ?? 0) === 0, onClick: emptyTrash, children: t("guard.cleanupTrashEmpty") })
] })
] }),
candidates.length === 0
? jsx("p", { style: { ...mutedStyle, margin: 0 }, children: t("guard.cleanupEmpty") })
: jsx("div", { style: { ...panelStyle, maxHeight: 280, overflowY: "auto", padding: 2 }, children: candidates.map((item) => jsx("label", {
key: item.path,
style: { display: "flex", gap: 8, alignItems: "center", fontSize: 12, padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l2)" },
children: [
jsx("input", { type: "checkbox", checked: selected.includes(item.path), onChange: () => toggle(item.path) }),
jsx("span", { style: { flex: 1, wordBreak: "break-all" }, children: item.path }),
jsx("span", { style: { ...mutedStyle, whiteSpace: "nowrap" }, children: `${formatBytes(item.sizeBytes)} · ${ageLabel(item.ageMs)}` })
]
}, item.path)) }),
feedback !== null ? jsx("div", { style: feedback.ok ? successStyle : errorStyle, children: feedback.text }) : null
] })
});

		}

		function GuardView({ t, notes }) {
			const { data, error, loading, reload } = useAutoRefresh(() => fetchJson("/resources/hardware.json"));
			const [dialog, setDialog] = useState(null);
			const [reason, setReason] = useState("");
			const [busy, setBusy] = useState(false);
			const [feedback, setFeedback] = useState(null);

			const confirmAdapt = (id, option) => {
				setBusy(true);
				setFeedback(null);
				postHardware({ action: "confirm-adapt", adaptationId: id, option })
					.then(({ status, ok, data: d }) => {
						setBusy(false);
						if (ok && d !== null) {
							setFeedback({ ok: true, text: d.text ?? "confirmed" });
							reload();
						} else {
							setFeedback({ ok: false, text: d?.error ?? `HTTP ${status}` });
						}
					})
					.catch((e) => {
						setBusy(false);
						setFeedback({ ok: false, text: String(e?.message ?? e) });
					});
			};

			const submit = () => {
				if (dialog === null) return;
				setBusy(true);
				setFeedback(null);
				postHardware({ action: dialog.action, reason })
					.then(({ status, ok, data: d }) => {
						setBusy(false);
						setDialog(null);
						setReason("");
						if (ok && d !== null) {
							setFeedback({ ok: true, text: d.text ?? `${dialog.action} done` });
							reload();
						} else {
							setFeedback({ ok: false, text: d?.error ?? `HTTP ${status}` });
						}
					})
					.catch((e) => {
						setBusy(false);
						setFeedback({ ok: false, text: String(e?.message ?? e) });
					});
			};

			if (loading && data === null) {
				return jsx("div", { style: mutedStyle, children: t("common.loading") });
			}
			if (error !== null || data === null) {
				return jsxs("div", {
					style: { display: "flex", flexDirection: "column", gap: 8 },
					children: [
						jsx("div", { style: errorStyle, children: `${t("common.error")}: ${error ?? "no data"}` }),
						jsx("div", {
							children: jsx("button", {
								type: "button",
								style: ghostButtonStyle,
								onClick: () => reload(),
								children: jsxs(Fragment, {
									children: [
										jsx(IconRefresh, { size: 14 }),
										jsx("span", { children: t("guard.refresh") })
									]
								})
							})
						})
					]
				});
			}

			const control = data.control ?? {};
			const budget = data.budget ?? {};
			const pressure = data.pressure ?? {};
			const adaptations = data.adaptations ?? { applied: [], pending: [] };
			const pending = Array.isArray(adaptations.pending) ? adaptations.pending : [];
			const applied = Array.isArray(adaptations.applied) ? adaptations.applied : [];
			const incidents = Array.isArray(data.incidents) ? data.incidents : [];
			const guardEnabledNow = control.enabled !== false;
			const hysteresis = pressure.hysteresis ?? {};

			const incidentRows = incidents.map((incident) => jsx("li", {
				style: { margin: "2px 0", fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
				children: `${incident.at ?? "?"} [${incident.kind ?? "?"}]`
			}, incident.atMs ?? incident.at ?? incidents.indexOf(incident)));

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 10 },
				children: [
					jsxs("div", {
						style: rowStyle,
						children: [
							jsx(StatusBadge, { enforcement: data.enforcement ?? "unknown", t }),
					jsx(Help, { notes, text: t("guard.help") }),
							jsx("span", { style: mutedStyle, children: `${t("guard.snapshotAt")} ${formatTime(data.at)}` }),
							jsx("span", { style: { flex: 1 } }),
							jsx("button", {
								type: "button",
								style: ghostButtonStyle,
								title: t("guard.refresh"),
								"aria-label": t("guard.refresh"),
								onClick: () => reload(),
								children: jsx(IconRefresh, { size: 14 })
							})
						]
					}),
					jsx(Card, {
						title: t("guard.controlSwitch"),
						children: jsxs("div", {
							style: { display: "flex", flexDirection: "column", gap: 8 },
							children: [
								jsxs("dl", {
									style: fieldGridStyle,
									children: [
										jsx(Field, { label: t("guard.field.revision"), value: control.revision }),
										jsx(Field, { label: t("guard.field.updatedBy"), value: control.updatedBy ?? "—" }),
										jsx(Field, { label: t("guard.field.updatedAt"), value: formatTime(control.updatedAt) }),
										control.reason !== undefined && control.reason !== ""
											? jsx(Field, { label: t("guard.reasonLabel"), value: control.reason })
											: null
									]
								}),
								jsxs("div", {
									style: rowStyle,
									children: [
										jsx("button", {
											type: "button",
											style: ghostButtonStyle,
											disabled: !guardEnabledNow || busy,
											onClick: () => setDialog({ action: "disable" }),
											children: jsxs(Fragment, {
												children: [
													jsx(IconClose, { size: 14 }),
													jsx("span", { children: t("guard.disable") })
												]
											})
										}),
										jsx("button", {
											type: "button",
											style: ghostButtonStyle,
											disabled: guardEnabledNow || busy,
											onClick: () => setDialog({ action: "enable" }),
											children: jsxs(Fragment, {
												children: [
													jsx(IconCheck, { size: 14 }),
													jsx("span", { children: t("guard.enable") })
												]
											})
										})
									]
								})
							]
						})
					}),
					jsx(Card, {
						title: t("guard.pressure"),
						children: jsxs("dl", {
							style: fieldGridStyle,
							children: [
								jsx(Field, { label: t("guard.field.state"), value: pressure.state }),
								jsx(Field, { label: t("guard.field.free"), value: formatBytes(pressure.freeBytes) }),
								jsx(Field, { label: t("guard.field.load1"), value: pressure.load1 ?? "?" }),
								jsx(Field, {
									label: t("guard.field.thresholds"),
									value: `warn load ${pressure.warnLoad ?? "?"} / free ${formatBytes(pressure.warnMemBytes)}; crit load ${pressure.critLoad ?? "?"} / free ${formatBytes(pressure.critMemBytes)}; exit warn load ${hysteresis.warnExitLoad ?? "?"}; exit crit load ${hysteresis.critExitLoad ?? "?"}; min dwell ${hysteresis.minStateMs ?? 0}ms`
								})
							]
						})
					}),
					jsx(Card, {
						title: t("guard.budget"),
						children: jsxs("dl", {
							style: fieldGridStyle,
							children: [
								jsx(Field, { label: t("guard.field.cpu"), value: `${budget.cpuBudgetCores ?? "?"} / ${budget.cpuCount ?? "?"} cores (${budget.cpuReservedCores ?? 0} reserved)` }),
								jsx(Field, { label: t("guard.field.memBudget"), value: formatBytes(budget.memBudgetBytes) }),
								jsx(Field, { label: t("guard.field.perCommandCap"), value: formatBytes(budget.perCommandMemCapBytes) }),
								jsx(Field, { label: t("guard.field.runaway"), value: formatBytes(budget.memoryRunawayBytes) }),
								jsx(Field, { label: t("guard.field.maxBgJobs"), value: budget.maxBackgroundJobs }),
								jsx(Field, { label: t("guard.field.nice"), value: budget.niceLevel }),
								jsx(Field, { label: t("guard.policy"), value: data.memoryCapPolicy ?? "none" })
							]
						})
					}),
					jsx(Card, {
						title: `${t("guard.adaptations")} — ${t("guard.pending")} ${pending.length}`,
						children: pending.length === 0
							? jsx("p", { style: mutedStyle, children: t("guard.noPending") })
							: jsx("ul", {
								style: { margin: 0, paddingLeft: 18 },
								children: pending.map((entry) => jsx(PendingAdaptation, {
									entry,
									t,
									onConfirm: confirmAdapt
								}, entry.id ?? entry.rule ?? `${entry.createdAt}`))
							})
					}),
					applied.length > 0
						? jsx(Card, {
							title: `${t("guard.adaptations")} — ${t("guard.applied")} ${applied.length}`,
							children: jsx("ul", {
								style: { margin: 0, paddingLeft: 18 },
								children: applied.map((entry) => jsx("li", {
									style: { margin: "2px 0", fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
									children: `${formatTime(entry.at)} [${adaptationRuleLabel(t, entry.rule)}] ${entry.option === DEFER_OPTION ? t("adapt.deferred") : optionTitle(t, entry.rule, entry.option) ?? ""}`
								}, entry.id ?? entry.rule ?? `${entry.at}`))
							})
						})
						: null,
					jsx(Card, {
						title: t("guard.incidents"),
						children: incidents.length === 0
							? jsx("p", { style: mutedStyle, children: "—" })
							: jsx("ul", { style: { margin: 0, paddingLeft: 18 }, children: incidentRows })
					}),
					feedback !== null
						? jsx("div", { style: feedback.ok ? successStyle : errorStyle, children: feedback.text })
						: null,
					dialog !== null
						? jsx(primitives.Modal, {
							open: true,
							onClose: () => setDialog(null),
							title: dialog.action === "disable" ? t("guard.confirmTitle.disable") : t("guard.confirmTitle.enable"),
							closeLabel: t("guard.cancel"),
							description: dialog.action === "disable" ? t("guard.confirmDescription.disable") : t("guard.confirmDescription.enable"),
							footer: jsxs("div", {
								style: { display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" },
								children: [
									jsx("input", {
										value: reason,
										onChange: (event) => setReason(event.target.value),
										placeholder: t("guard.reasonPlaceholder"),
										style: { ...inputStyle, flex: 1, minWidth: 220 },
										"aria-label": t("guard.reasonLabel")
									}),
									jsx(primitives.Button, {
										variant: "ghost",
										onClick: () => setDialog(null),
										children: t("guard.cancel")
									}),
									jsx(primitives.Button, {
										variant: "primary",
										disabled: busy,
										onClick: submit,
										children: t("guard.confirm")
									})
								]
							})
						})
						: null
				]
			});
		}

		// ── Projects tab ────────────────────────────────────────────────────

function ProcessLookup({ t, currentSessionId }) {
const [open, setOpen] = useState(false);
const [scope, setScope] = useState("session");
const [sessionId, setSessionId] = useState(currentSessionId ?? "");
const [sort, setSort] = useState("rss");
const [busy, setBusy] = useState(false);
const [error, setError] = useState(null);
const [result, setResult] = useState(null);
const search = () => {
const query = new URLSearchParams({ scope, sort, limit: "20" });
if (scope === "session") {
const requested = sessionId.trim();
if (requested === "") { setError(t("projects.processSessionRequired")); return; }
query.set("sessionId", requested);
}
setBusy(true);
setError(null);
fetchJson(`/resources/processes.json?${query.toString()}`)
.then((data) => { setBusy(false); setResult(data); })
.catch((err) => { setBusy(false); setError(String(err?.message ?? err)); });
};
if (!open) {
return jsx("div", { style: rowStyle, children: jsx("button", { type: "button", style: ghostButtonStyle, onClick: () => setOpen(true), children: t("projects.processLookup") }) });
}
const processes = Array.isArray(result?.processes) ? result.processes : [];
return jsx(Card, {
title: t("projects.processLookupTitle"),
children: jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 8 }, children: [
jsx("p", { style: mutedStyle, children: t("projects.processLookupHelp") }),
jsxs("div", { style: rowStyle, children: [
jsx("button", { type: "button", style: { ...ghostButtonStyle, borderColor: scope === "session" ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-border-l2)" }, onClick: () => setScope("session"), children: t("projects.scopeSession") }),
jsx("button", { type: "button", style: { ...ghostButtonStyle, borderColor: scope === "system" ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-border-l2)" }, onClick: () => setScope("system"), children: t("projects.scopeSystem") }),
scope === "session" ? jsx("input", { value: sessionId, onChange: (event) => setSessionId(event.target.value), placeholder: t("projects.sessionIdPlaceholder"), style: { ...inputStyle, flex: 1, minWidth: 220 }, "aria-label": t("projects.sessionId") }) : null,
scope === "session" && currentSessionId ? jsx("button", { type: "button", style: ghostButtonStyle, onClick: () => setSessionId(currentSessionId), children: t("projects.useCurrentSession") }) : null,
jsx("button", { type: "button", style: ghostButtonStyle, onClick: () => setSort((value) => value === "rss" ? "cpu" : "rss"), children: `${t("projects.sortBy")}: ${sort === "rss" ? t("projects.sortRss") : t("projects.sortCpu")}` }),
jsx("button", { type: "button", style: ghostButtonStyle, disabled: busy, onClick: search, children: busy ? t("projects.processSearching") : t("projects.processSearch") }),
jsx("button", { type: "button", style: ghostButtonStyle, onClick: () => setOpen(false), children: t("guard.cancel") })
] }),
error !== null ? jsx("div", { style: errorStyle, children: error }) : null,
result !== null
? jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: [
jsx("div", { style: mutedStyle, children: `${t("projects.processSnapshot")}: ${formatTime(result.at)} · ${result.scope === "session" ? t("projects.scopeSession") : t("projects.scopeSystem")} · ${processes.length}` }),
processes.length === 0
? jsx("p", { style: mutedStyle, children: t("projects.noProcesses") })
: jsxs("table", { style: tableStyle, children: [
jsx("thead", { children: jsxs("tr", { children: [
jsx("th", { style: cellStyle, children: "pid" }),
jsx("th", { style: cellStyle, children: "rss" }),
jsx("th", { style: cellStyle, children: "cpu%" }),
jsx("th", { style: cellStyle, children: "session" }),
jsx("th", { style: cellStyle, children: "command" })
] }) }),
jsx("tbody", { children: processes.map((proc) => jsxs("tr", { children: [
jsx("td", { style: cellStyle, children: proc.pid ?? "?" }),
jsx("td", { style: cellStyle, children: formatBytes(proc.rssBytes) }),
jsx("td", { style: cellStyle, children: proc.cpuPct ?? "—" }),
jsx("td", { style: cellStyle, children: proc.sessionId ?? "—" }),
jsx("td", { style: { ...cellStyle, wordBreak: "break-all" }, children: proc.command || proc.comm || "—" })
] }, `${proc.pid}-${proc.comm}`)) })
] })
] })
: null
] })
});
}

function MonitorEntry({ t, entry, onStop }) {
const sessionId = entry.owner?.sessionId ?? entry.sessionId ?? null;
const label = entry.projectId || entry.taskId
? `${entry.projectId ?? "?"}${entry.taskId ? ` / ${entry.taskId}` : ""}`
: entry.source === "orphan" ? t("monitor.orphan") : entry.source ?? t("monitor.unknownSource");
const status = entry.state === "occupied" ? t("projects.occupied") : entry.state === "orphan" ? t("monitor.orphan") : entry.status ?? t("projects.waiting");
const canStop = entry.source === "resource-run" || entry.owner?.runId;
const canCancel = !canStop && entry.source === "scheduler" && entry.id;
const details = [
entry.unit,
entry.pid !== undefined && entry.pid !== null ? `pid ${entry.pid}` : null,
entry.durationMs !== undefined && entry.durationMs !== null ? formatDuration(entry.durationMs) : null,
entry.waitingMs !== undefined && entry.waitingMs !== null ? `${t("projects.waitTime")} ${formatDuration(entry.waitingMs)}` : null,
entry.comm,
formatArgv(entry.command, 100) || null
].filter(Boolean);
return jsxs("li", {
style: { margin: "6px 0", padding: "6px 8px", borderLeft: "2px solid var(--dsw-alias-border-l2)", display: "flex", flexDirection: "column", gap: 3, fontSize: 12 },
children: [
jsxs("div", { style: rowStyle, children: [
jsx("span", { style: { ...badgeStyle, borderColor: entry.source === "orphan" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-border-l2)", color: entry.source === "orphan" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-secondary)" }, children: status }),
jsx("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary)" }, children: label }),
sessionId ? jsx("span", { style: mutedStyle, children: `session ${sessionId}` }) : jsx("span", { style: dangerStyle, children: t("projects.unassigned") }),
jsx("span", { style: { flex: 1 } }),
canStop ? jsx("button", { type: "button", style: ghostButtonStyle, title: t("projects.stopTaskHint"), onClick: () => onStop(entry, "stop"), children: t("projects.stopTask") }) : null,
canCancel ? jsx("button", { type: "button", style: ghostButtonStyle, title: t("projects.cancelQueuedHint"), onClick: () => onStop(entry, "cancel"), children: t("projects.cancelQueued") }) : null
] }),
details.length > 0 ? jsx("div", { style: { ...mutedStyle, wordBreak: "break-all" }, children: details.join(" · ") }) : null,
entry.cgroup ? jsx("div", { style: { ...mutedStyle, wordBreak: "break-all" }, children: entry.cgroup }) : null
]
});
}

function ResourceOverview({ t, currentSessionId }) {
const { data, error, loading, reload } = useAutoRefresh(() => fetchJson("/resources/projects.json"));
const hardware = useAutoRefresh(() => fetchJson("/resources/hardware.json"));
const monitors = useHiddenMonitors();
const [feedback, setFeedback] = useState(null);
const [openSessions, setOpenSessions] = useState(() => new Set());
const safeOpenSessions = openSessions instanceof Set ? openSessions : new Set();
if (loading && data === null) return jsx("div", { style: mutedStyle, children: t("common.loading") });
if (error !== null || data === null) {
return jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 8 }, children: [
jsx("div", { style: errorStyle, children: `${t("common.error")}: ${error ?? "no data"}` }),
jsx("button", { type: "button", style: ghostButtonStyle, onClick: () => reload(), children: t("guard.refresh") })
] });
}
const projects = Array.isArray(data.projects) ? data.projects : [];
const waitingEntries = waitingEntryList(data.waiting);
const orphanEntries = [];
const seenOrphans = new Set();
for (const project of projects) {
for (const orphan of Array.isArray(project.orphans) ? project.orphans : []) {
const key = String(orphan.pid ?? orphan.comm ?? Math.random());
if (seenOrphans.has(key)) continue;
seenOrphans.add(key);
orphanEntries.push({
source: "orphan",
id: `orphan:${key}`,
state: "orphan",
status: t("monitor.orphan"),
owner: orphan.sessionId ? { kind: "session", sessionId: orphan.sessionId } : null,
sessionId: orphan.sessionId ?? null,
projectId: project.project?.id ?? null,
taskId: null,
pid: orphan.pid ?? null,
comm: orphan.comm ?? null,
cgroup: orphan.cgroup ?? null,
command: orphan.argv ?? null,
projectKnown: true,
taskKnown: false,
unassigned: true
});
}
}
const entries = [...waitingEntries, ...orphanEntries].filter((entry) => !monitors.hidden.has(slotMonitorKey(entry)));
const sessionOf = (entry) => entry.owner?.sessionId ?? entry.sessionId ?? null;
const current = entries.filter((entry) => sessionOf(entry) === (currentSessionId ?? null));
const other = entries.filter((entry) => sessionOf(entry) !== (currentSessionId ?? null));
const otherGroups = new Map();
for (const entry of other) {
const sid = sessionOf(entry) ?? t("projects.unassigned");
const group = otherGroups.get(sid) ?? [];
group.push(entry);
otherGroups.set(sid, group);
}
const stopEntry = (entry, kind) => {
const confirmText = kind === "stop" ? t("projects.stopConfirm") : t("projects.cancelConfirm");
if (typeof globalThis.confirm === "function" && globalThis.confirm(confirmText) !== true) return;
const runId = kind === "stop" ? (entry.owner?.runId ?? entry.id) : null;
const payload = kind === "stop"
? { action: "stop-run", runId, confirm: "STOP" }
: { action: "cancel-queue", itemId: entry.id, confirm: "CANCEL" };
setFeedback(null);
postJson("/resources/projects", payload).then(({ status, ok, data: response }) => {
if (!ok) { setFeedback({ ok: false, text: response?.error ?? `HTTP ${status}` }); return; }
monitors.hide(slotMonitorKey(entry));
setFeedback({ ok: true, text: response?.text ?? t("projects.actionDone") });
reload();
}).catch((err) => setFeedback({ ok: false, text: String(err?.message ?? err) }));
};
const toggleSession = (sid) => setOpenSessions((currentSet) => {
const next = new Set(currentSet instanceof Set ? currentSet : []);
if (next.has(sid)) next.delete(sid); else next.add(sid);
return next;
});
return jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 10, minHeight: 0, overflowY: "auto" }, children: [
jsxs("div", { style: rowStyle, children: [
jsx("span", { style: { ...badgeStyle, borderColor: "var(--dsw-alias-state-business-primary)", color: "var(--dsw-alias-state-business-primary)" }, children: t("monitor.title") }),
jsx("span", { style: mutedStyle, children: `${t("monitor.current")} ${currentSessionId ?? "—"} · ${t("monitor.entries")} ${entries.length}` }),
jsx("span", { style: { flex: 1 } }),
monitors.hidden.size > 0 ? jsx("button", { type: "button", style: ghostButtonStyle, onClick: () => { monitors.restoreAll(); reload(); }, children: `${t("monitor.restore")} (${monitors.hidden.size})` }) : null,
jsx("button", { type: "button", style: ghostButtonStyle, onClick: () => reload(), children: t("guard.refresh") })
] }),
jsx(ProcessLookup, { t, currentSessionId }),
feedback !== null ? jsx("div", { style: feedback.ok ? successStyle : errorStyle, children: feedback.text }) : null,
jsx(Card, {
title: `${t("monitor.currentSection")} — ${current.length}`,
children: current.length === 0
? jsx("p", { style: mutedStyle, children: t("monitor.noCurrent") })
: jsx("ul", { style: { margin: 0, padding: 0, listStyle: "none" }, children: current.map((entry, index) => jsx(MonitorEntry, { t, entry, onStop: stopEntry }, `${entry.source}-${entry.id}-${index}`)) })
}),
jsx(Card, {
title: `${t("monitor.otherSection")} — ${otherGroups.size}`,
children: otherGroups.size === 0
? jsx("p", { style: mutedStyle, children: t("monitor.noOther") })
: jsx("div", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: [...otherGroups.entries()].map(([sid, group]) => jsxs("div", { children: [
jsxs("button", { type: "button", style: { ...ghostButtonStyle, width: "100%", justifyContent: "space-between" }, onClick: () => toggleSession(sid), children: [
jsx("span", { children: `${sid} · ${group.length}` }),
jsx("span", { children: safeOpenSessions.has(sid) ? t("monitor.collapse") : t("monitor.expand") })
] }),
safeOpenSessions.has(sid)
? jsx("ul", { style: { margin: "4px 0 0", padding: 0, listStyle: "none" }, children: group.map((entry, index) => jsx(MonitorEntry, { t, entry, onStop: stopEntry }, `${entry.source}-${entry.id}-${index}`)) })
: null
] }, sid)) })
}),
hardware.data?.cleanup !== undefined
? jsx(CleanupCard, { t, cleanup: hardware.data.cleanup, reload: hardware.reload })
: null
] });
}

		function NotesToggle({ t, notes, onToggle }) {
			return jsxs("button", {
				type: "button",
				role: "switch",
				"aria-checked": notes ? "true" : "false",
				onClick: onToggle,
				title: t("view.notes"),
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 6,
					background: "0 0",
					border: "none",
					cursor: "pointer",
					color: "var(--dsw-alias-label-tertiary)",
					fontSize: 12,
					padding: "2px 0"
				},
				children: [
					jsx("span", { children: t("view.notes") }),
					jsxs("span", {
						style: {
							width: 30,
							height: 16,
							borderRadius: 999,
							background: notes ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-border-l2)",
							display: "inline-block",
							position: "relative",
							transition: "background .15s"
						},
						children: jsx("span", {
							style: {
								position: "absolute",
								top: 2,
								left: notes ? 16 : 2,
								width: 12,
								height: 12,
								borderRadius: "50%",
								background: "var(--dsw-alias-bg-base)",
								transition: "left .15s"
							}
						})
					})
				]
			});
		}

		function ResourcesView({ t, currentSessionId }) {
			const [tab, setTab] = useState("monitor");
			const [notes, setNotes] = useState(() => {
				try {
					const current = localStorage.getItem(NOTES_STORAGE_KEY);
					if (current !== null) return current === "1";
					return localStorage.getItem(LEGACY_NOTES_STORAGE_KEY) === "1";
				} catch {
					return false;
				}
			});
			const toggleNotes = () => {
				setNotes((current) => {
					const next = !current;
					try {
						localStorage.setItem(NOTES_STORAGE_KEY, next ? "1" : "0");
						localStorage.removeItem(LEGACY_NOTES_STORAGE_KEY);
					} catch { /* ignore */ }
					return next;
				});
			};
			const tabButton = (id, icon, labelKey) => jsx(primitives.Pill, {
				active: tab === id,
				onClick: () => setTab(id),
				children: jsxs(Fragment, {
					children: [
						icon,
						jsx("span", { style: { marginLeft: 4 }, children: t(labelKey) })
					]
				})
			}, id);
			return jsxs("div", {
				style: rootStyle,
				"data-resource-allocation-root": "1",
				children: [
					jsxs("div", {
						style: tabBarStyle,
						children: [
							tabButton("guard", jsx(IconData, { size: 14 }), "tab.guard"),
							tabButton("monitor", jsx(IconQueue, { size: 14 }), "tab.monitor"),
							jsx(NotesToggle, { t, notes, onToggle: toggleNotes })
						]
					}),
					tab === "guard"
						? jsx(GuardView, { t, notes })
						: jsx(ResourceOverview, { t, currentSessionId })
				]
			});
		}

		exports.inject = ["slots", "locale"];
		exports.apply = (ctx) => {
			document.body.dataset.resourceAllocation = "applied";
			const hideHandleId = "resource-allocation-hide-width-handle";
			if (typeof document !== "undefined" && typeof document.getElementById === "function" && document.getElementById(hideHandleId) === null) {
				const styleEl = document.createElement("style");
				styleEl.id = hideHandleId;
				styleEl.textContent = "body:has([data-resource-allocation-root]) [class*='_widthHandle']{display:none!important}";
				document.head.appendChild(styleEl);
			}
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "resource-allocation: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "resources",
				order: 20,
				locale: NS,
				label: () => t("view.resources"),
				inject: (sessionId) => ({ currentSessionId: sessionId })
			}, ResourcesView));
		};
		return module.exports;
	}
});
