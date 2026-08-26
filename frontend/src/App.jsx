import {
  Activity,
  Archive,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Clock3,
  CloudDownload,
  Copy,
  Database,
  ExternalLink,
  Eye,
  FileClock,
  Gamepad2,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  PackageCheck,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  ScrollText,
  Square,
  Trash2,
  Truck,
  UserRound,
  X,
} from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Progress,
  Select,
  Separator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@/components/ui";
import { ApiError, api, jsonBody } from "@/lib/api";
import {
  cn,
  formatDate,
  formatNumber,
  statusTone,
} from "@/lib/utils";

const navigation = [
  { id: "dashboard", label: "看板", icon: LayoutDashboard },
  { id: "tasks", label: "任务", icon: FileClock },
  { id: "products", label: "商品配置", icon: Boxes },
  { id: "games", label: "游戏数据", icon: Gamepad2 },
  { id: "keys", label: "API Key 管理", icon: KeyRound },
];

const routeTitles = Object.fromEntries(
  navigation.map((item) => [item.id, item.label]),
);
const statusLabels = {
  pending: "待处理",
  running: "运行中",
  publishing: "发布中",
  success: "成功",
  missing: "缺失",
  violation: "违规",
  failed: "失败",
  partial: "部分完成",
  interrupted: "已中断",
  unknown: "待确认",
  none: "无",
  material: "加入素材库",
  published: "发布成功",
  updated: "已更新",
};

const productConfigAccountStorageKey = "gamer520.product-config.account-id";
const gamesAccountStorageKey = "gamer520.games.account-id";

function storedAccountId(storageKey) {
  try {
    return window.localStorage.getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}

function useRememberedAccountId(storageKey) {
  const [accountId, setAccountId] = useState(() => storedAccountId(storageKey));

  useEffect(() => {
    try {
      if (accountId) {
        window.localStorage.setItem(storageKey, accountId);
      } else {
        window.localStorage.removeItem(storageKey);
      }
    } catch {
      // 浏览器禁用本地存储时仍保持当前页面内的选择。
    }
  }, [accountId, storageKey]);

  return [accountId, setAccountId];
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "操作失败";
}

function usePolling(load, interval = 5000) {
  useEffect(() => {
    let active = true;
    let timer;
    const run = async () => {
      if (!active) return;
      await load();
      if (active) timer = window.setTimeout(run, interval);
    };
    void run();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load, interval]);
}

function StatusBadge({ status }) {
  return (
    <Badge tone={statusTone(status)}>
      {statusLabels[status] ?? status ?? "—"}
    </Badge>
  );
}

function SegmentedProgress({
  success = 0,
  skipped = 0,
  failed = 0,
  total = 0,
  label,
}) {
  const maximum = Math.max(Number(total) || 0, 1);
  const segments = [
    {
      key: "success",
      label: "成功",
      value: Math.max(Number(success) || 0, 0),
      className: "bg-emerald-500",
      textClassName: "text-emerald-700",
    },
    {
      key: "skipped",
      label: "已有跳过",
      value: Math.max(Number(skipped) || 0, 0),
      className: "bg-amber-400",
      textClassName: "text-amber-700",
    },
    {
      key: "failed",
      label: "失败",
      value: Math.max(Number(failed) || 0, 0),
      className: "bg-rose-500",
      textClassName: "text-rose-700",
    },
  ];
  return (
    <div className="space-y-2" aria-label={label}>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100">
        {segments.map((segment) =>
          segment.value > 0 ? (
            <span
              key={segment.key}
              className={segment.className}
              style={{
                width: `${Math.min(100, (segment.value / maximum) * 100)}%`,
              }}
              title={`${segment.label} ${segment.value}`}
            />
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-data text-[10px]">
        {segments.map((segment) => (
          <span key={segment.key} className={segment.textClassName}>
            {segment.label} {segment.value}
          </span>
        ))}
      </div>
    </div>
  );
}

function TaskLogDialog({ task, open, onOpenChange }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const afterIdRef = useRef(0);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!open || !task) return undefined;
    let active = true;
    let timer;
    afterIdRef.current = 0;
    setItems([]);
    setError("");

    const load = async () => {
      if (!active) return;
      setLoading(true);
      try {
        let hasMore = true;
        const collected = [];
        while (active && hasMore) {
          const payload = await api(
            `/api/task-logs?task_type=${encodeURIComponent(task.taskType)}&run_id=${task.id}&after_id=${afterIdRef.current}&limit=500`,
          );
          const nextItems = payload.items ?? [];
          collected.push(...nextItems);
          afterIdRef.current =
            payload.nextAfterId ?? afterIdRef.current;
          hasMore = Boolean(payload.hasMore);
        }
        if (active && collected.length > 0) {
          setItems((current) => {
            const byId = new Map(
              [...current, ...collected].map((item) => [item.id, item]),
            );
            return [...byId.values()].sort((left, right) => left.id - right.id);
          });
        }
        if (active) setError("");
      } catch (caught) {
        if (active) setError(errorMessage(caught));
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(load, 2000);
        }
      }
    };
    void load();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, task]);

  useEffect(() => {
    if (!open || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [items, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <div className="flex flex-wrap items-center gap-3">
            <DialogTitle>
              {task?.taskType === "crawl" ? "采集" : "同步"}任务 #{task?.id} 操作日志
            </DialogTitle>
            {task?.status ? <StatusBadge status={task.status} /> : null}
          </div>
          <DialogDescription>
            按执行顺序展示每一步操作、结果与关联数据；运行中每 2 秒自动刷新。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between border-b bg-slate-50 px-6 py-3 text-xs text-muted-foreground">
          <span>共 {items.length} 条日志</span>
          <span className="flex items-center gap-2">
            {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
            {loading ? "正在读取" : "已同步"}
          </span>
        </div>
        <div ref={scrollRef} className="max-h-[62vh] overflow-y-auto p-4">
          {error ? (
            <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              {error}
            </p>
          ) : null}
          {items.length ? (
            <div className="space-y-2">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="rounded-lg border bg-white p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        item.level === "success"
                          ? "success"
                          : item.level === "warning"
                            ? "warning"
                            : item.level === "error"
                              ? "danger"
                              : "info"
                      }
                    >
                      {item.stage} · {item.action}
                    </Badge>
                    {item.gameId ? (
                      <span className="font-data text-[10px] text-muted-foreground">
                        游戏 {item.gameId}
                      </span>
                    ) : null}
                    <span className="ml-auto font-data text-[10px] text-muted-foreground">
                      {formatDate(item.createdAt)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6">{item.message}</p>
                  {item.details ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-primary">
                        查看详细结果
                      </summary>
                      <pre className="font-data mt-2 overflow-x-auto rounded-md bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">
                        {JSON.stringify(item.details, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
              ))}
            </div>
          ) : !loading ? (
            <EmptyState
              title="该任务还没有详细日志"
              description="旧版本创建的任务不会补写历史操作日志。"
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PageHeading({ eyebrow, title, description, actions }) {
  return (
    <div className="mb-6 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
      <div className="min-w-0">
        <p className="font-data text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
          {eyebrow}
        </p>
        <h1 className="font-display mt-2 text-3xl font-bold tracking-tight">
          {title}
        </h1>
        <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

function EmptyState({ title, description }) {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center rounded-lg border border-dashed bg-muted/25 p-6 text-center">
      <Archive className="mb-3 h-6 w-6 text-muted-foreground" />
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function LoginPage({ onLoggedIn }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: jsonBody({ username, password }),
      });
      await onLoggedIn();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-grid min-h-screen bg-slate-50">
      <div className="mx-auto grid min-h-screen max-w-6xl items-center gap-10 px-6 py-12 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="hidden lg:block">
          <div className="mb-10 inline-flex items-center gap-3 rounded-full border bg-white px-4 py-2 text-sm font-medium shadow-sm">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#0f1d35] text-xs font-bold text-white">
              G5
            </span>
            Gamer520 自动发货后台
          </div>
          <p className="font-data text-xs font-semibold uppercase tracking-[0.22em] text-primary">
            Operations control
          </p>
          <h1 className="font-display mt-4 max-w-2xl text-5xl font-bold leading-[1.06] tracking-tight text-slate-950">
            从采集到发货，
            <br />
            每一步都有记录。
          </h1>
          <p className="mt-6 max-w-xl text-base leading-7 text-slate-600">
            管理 Gamer520 数据采集、素材去重、闲鱼发布与卡券绑定。失败商品自动跳过，任务进度和历史结果集中查看。
          </p>
          <div className="sync-rail relative mt-12 grid max-w-2xl grid-cols-4">
            {[
              [CloudDownload, "采集"],
              [Database, "素材"],
              [Truck, "发布"],
              [PackageCheck, "卡券"],
            ].map(([Icon, label]) => (
              <div key={label} className="relative z-10 text-center">
                <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border bg-white text-primary shadow-sm">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="mt-3 block text-xs font-semibold text-slate-600">
                  {label}
                </span>
              </div>
            ))}
          </div>
        </section>

        <Card className="mx-auto w-full max-w-md border-slate-200 shadow-xl shadow-slate-200/70">
          <CardHeader className="space-y-3 p-8">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#0f1d35] text-white">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="font-display text-2xl">登录运营后台</CardTitle>
              <CardDescription className="mt-2">
                使用管理员账号进入受保护的控制台。
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="p-8 pt-0">
            <form className="space-y-5" onSubmit={submit}>
              <div className="space-y-2">
                <Label htmlFor="username">账号</Label>
                <div className="relative">
                  <UserRound className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="username"
                    className="pl-9"
                    autoComplete="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">密码</Label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="password"
                    className="pl-9"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                </div>
              </div>
              {error ? (
                <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {error}
                </p>
              ) : null}
              <Button className="w-full" size="lg" disabled={loading}>
                {loading ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4" />
                )}
                {loading ? "正在验证" : "进入后台"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

function Sidebar({ route, onRoute, onLogout, open, onClose }) {
  return (
    <>
      {open ? (
        <button
          className="fixed inset-0 z-30 bg-slate-950/35 lg:hidden"
          onClick={onClose}
          aria-label="关闭导航"
        />
      ) : null}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-[#0f1d35] text-white transition-transform lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-20 items-center justify-between border-b border-white/10 px-6">
          <button
            className="flex items-center gap-3 text-left"
            onClick={() => onRoute("dashboard")}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary font-display text-sm font-bold">
              G5
            </span>
            <span>
              <strong className="block font-display text-lg tracking-tight">
                G520 Console
              </strong>
              <small className="font-data text-[10px] uppercase tracking-[0.14em] text-slate-400">
                delivery ops
              </small>
            </span>
          </button>
          <Button
            className="text-slate-300 lg:hidden"
            variant="ghost"
            size="icon"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        <nav className="flex-1 space-y-1 p-4">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition",
                  route === item.id
                    ? "bg-white text-slate-950 shadow-sm"
                    : "text-slate-300 hover:bg-white/8 hover:text-white",
                )}
                onClick={() => {
                  onRoute(item.id);
                  onClose();
                }}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="border-t border-white/10 p-4">
          <div className="mb-3 rounded-lg bg-white/5 p-3">
            <p className="text-xs font-medium text-slate-200">管理员</p>
            <p className="mt-1 font-data text-[10px] uppercase tracking-wide text-slate-500">
              authenticated session
            </p>
          </div>
          <button
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-slate-300 transition hover:bg-white/8 hover:text-white"
            onClick={onLogout}
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </button>
        </div>
      </aside>
    </>
  );
}

function StatCard({ icon: Icon, label, value, note, tone = "blue" }) {
  const colors = {
    blue: "bg-blue-50 text-blue-700",
    green: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    slate: "bg-slate-100 text-slate-700",
  };
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="font-display mt-2 text-3xl font-bold tracking-tight">
              {formatNumber(value)}
            </p>
          </div>
          <span className={cn("rounded-lg p-2.5", colors[tone])}>
            <Icon className="h-5 w-5" />
          </span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  );
}

function SyncRail({ dashboard }) {
  const sync = dashboard?.scheduler?.sync ?? {};
  const progress = sync.progress;
  const latest = dashboard?.xianyu?.latestSyncRun;
  const steps = [
    {
      icon: CloudDownload,
      label: "采集",
      detail: dashboard?.latestRun
        ? `${dashboard.latestRun.detailSucceeded ?? 0} 成功`
        : "尚无记录",
      active: dashboard?.scheduler?.active,
    },
    {
      icon: Database,
      label: "素材",
      detail: progress
        ? `${dashboard?.totals?.materialSynced ?? 0} 已同步 · 本轮 ${progress.materialCompleted ?? 0}/${progress.materialTotal ?? 0}`
        : `${dashboard?.totals?.materialSynced ?? 0} 已同步`,
      active: progress?.phase === "material",
    },
    {
      icon: Truck,
      label: "发布",
      detail: progress
        ? `${dashboard?.totals?.publishedGames ?? 0} 已发布 · 本轮 ${progress.publishCompleted ?? 0}/${progress.publishTotal ?? 0}`
        : `${dashboard?.totals?.publishedGames ?? 0} 已发布`,
      active: progress?.phase === "publishing",
    },
    {
      icon: PackageCheck,
      label: "卡券",
      detail: latest ? `${latest.cardBound ?? 0} 已关联` : "等待发布",
      active: progress?.phase === "binding-card",
    },
  ];
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b bg-slate-50/70">
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>自动发货链路</CardTitle>
            <CardDescription className="mt-1">
              任务账号：
              {dashboard?.xianyu?.accountIds?.length
                ? dashboard.xianyu.accountIds.join("、")
                : "未选择"}
            </CardDescription>
          </div>
          <StatusBadge
            status={
              sync.active
                ? "running"
                : latest?.status ?? "pending"
            }
          />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid divide-y sm:grid-cols-4 sm:divide-x sm:divide-y-0">
          {steps.map(({ icon: Icon, label, detail, active }) => (
            <div
              key={label}
              className={cn(
                "relative p-5",
                active && "bg-blue-50/70",
              )}
            >
              <div className="mb-4 flex items-center justify-between">
                <span
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-full border bg-white",
                    active
                      ? "border-blue-200 text-primary shadow-sm"
                      : "text-slate-500",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                {active ? (
                  <Activity className="h-4 w-4 animate-pulse text-primary" />
                ) : (
                  <Check className="h-4 w-4 text-emerald-500" />
                )}
              </div>
              <p className="text-sm font-semibold">{label}</p>
              <p className="mt-1 font-data text-xs text-muted-foreground">
                {detail}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function DashboardPage({ notify }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [logTask, setLogTask] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await api("/api/dashboard"));
      setError("");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);
  usePolling(load);

  async function startSync() {
    try {
      await api("/api/sync/run", {
        method: "POST",
        body: jsonBody({ mode: "pending" }),
      });
      notify("未发布商品同步已启动");
      await load();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="Overview"
        title="运营看板"
        description="快速确认数据规模、链路状态和需要处理的异常。"
        actions={
          <Button onClick={startSync}>
            <Play className="h-4 w-4" />
            同步未发布商品
          </Button>
        }
      />
      {error ? (
        <p className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Gamepad2}
          label="总游戏数据"
          value={data?.totals?.games}
          note="当前数据库全部游戏记录"
        />
        <StatCard
          icon={ShieldCheck}
          label="有效游戏数据"
          value={data?.totals?.validGames}
          note="图片与有效下载链接完整"
        />
        <StatCard
          icon={Database}
          label="已同步素材库数据"
          value={data?.totals?.materialSynced}
          note="同名或已有素材自动跳过"
          tone="slate"
        />
        <StatCard
          icon={PackageCheck}
          label="已发布数据"
          value={data?.totals?.publishedGames}
          note="商品编号已回写 Gamer520"
          tone="green"
        />
      </div>
      <div className="mt-5">
        <SyncRail dashboard={data} />
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
        <Card>
          <CardHeader>
            <CardTitle>当前任务</CardTitle>
            <CardDescription>采集与同步只允许一个任务运行。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {data?.scheduler?.sync?.progress ? (
              <>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium">
                      {data.scheduler.sync.progress.currentTitle ?? "正在处理"}
                    </p>
                    <p className="mt-1 font-data text-xs text-muted-foreground">
                      ID {data.scheduler.sync.progress.currentGameId ?? "—"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setLogTask({
                          taskType: "sync",
                          id: data.scheduler.sync.progress.runId,
                          status: "running",
                        })
                      }
                    >
                      <ScrollText className="h-3.5 w-3.5" />
                      查看日志
                    </Button>
                    <StatusBadge status="running" />
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span>导入素材库</span>
                    <span className="font-data">
                      {data.scheduler.sync.progress.materialCompleted ?? 0} /{" "}
                      {data.scheduler.sync.progress.materialTotal ?? 0}
                    </span>
                  </div>
                  <SegmentedProgress
                    success={data.scheduler.sync.progress.materialSuccess}
                    skipped={data.scheduler.sync.progress.materialSkipped}
                    failed={data.scheduler.sync.progress.materialFailed}
                    total={data.scheduler.sync.progress.materialTotal}
                    label="导入素材库进度"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span>发布商品</span>
                    <span className="font-data">
                      {data.scheduler.sync.progress.publishCompleted ?? 0} /{" "}
                      {data.scheduler.sync.progress.publishTotal ?? 0}
                    </span>
                  </div>
                  <SegmentedProgress
                    success={data.scheduler.sync.progress.publishSuccess}
                    skipped={data.scheduler.sync.progress.publishSkipped}
                    failed={data.scheduler.sync.progress.publishFailed}
                    total={data.scheduler.sync.progress.publishTotal}
                    label="发布商品进度"
                  />
                </div>
              </>
            ) : data?.currentRun ? (
              <>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium">
                      采集任务 #{data.currentRun.id}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      已发现 {data.currentRun.discoveredCount ?? 0} 个游戏
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setLogTask({
                          taskType: "crawl",
                          id: data.currentRun.id,
                          status: data.currentRun.status,
                        })
                      }
                    >
                      <ScrollText className="h-3.5 w-3.5" />
                      查看日志
                    </Button>
                    <StatusBadge status={data.currentRun.status} />
                  </div>
                </div>
                <SegmentedProgress
                  success={data.currentRun.detailSucceeded}
                  skipped={data.currentRun.detailSkipped}
                  failed={data.currentRun.detailFailed}
                  total={data.currentRun.discoveredCount}
                  label="采集任务进度"
                />
              </>
            ) : (
              <EmptyState
                title="当前没有运行中的任务"
                description="可从任务页启动采集或同步。"
              />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>最近异常</CardTitle>
            <CardDescription>最近采集阶段记录的错误。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data?.recentErrors?.length ? (
              data.recentErrors.slice(0, 4).map((item) => (
                <div key={item.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <Badge tone="danger">{item.stage}</Badge>
                    <span className="font-data text-[10px] text-muted-foreground">
                      {formatDate(item.createdAt)}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm">{item.errorMessage}</p>
                </div>
              ))
            ) : (
              <EmptyState title="没有异常记录" description="运行状态正常。" />
            )}
          </CardContent>
        </Card>
      </div>
      <TaskLogDialog
        task={logTask}
        open={Boolean(logTask)}
        onOpenChange={(open) => {
          if (!open) setLogTask(null);
        }}
      />
    </>
  );
}

function TaskProgress({ schedule, crawlRun, onViewLogs }) {
  const progress = schedule?.sync?.progress;
  if (!progress && !crawlRun) return null;
  if (!progress) {
    return (
      <Card className="border-blue-200 bg-blue-50/40">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>采集任务 #{crawlRun.id}</CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onViewLogs(crawlRun)}
              >
                <ScrollText className="h-3.5 w-3.5" />
                查看日志
              </Button>
              <StatusBadge status={crawlRun.status} />
            </div>
          </div>
          <CardDescription>
            已发现 {crawlRun.discoveredCount ?? 0} 个游戏
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SegmentedProgress
            success={crawlRun.detailSucceeded}
            skipped={crawlRun.detailSkipped}
            failed={crawlRun.detailFailed}
            total={crawlRun.discoveredCount}
            label="采集任务进度"
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="border-blue-200 bg-blue-50/40">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>同步任务 #{progress.runId}</CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                onViewLogs({
                  taskType: "sync",
                  id: progress.runId,
                  status: "running",
                })
              }
            >
              <ScrollText className="h-3.5 w-3.5" />
              查看日志
            </Button>
            <StatusBadge status="running" />
          </div>
        </div>
        <CardDescription>
          账号 {progress.accountIndex ?? 1}/{progress.accountCount ?? 1}
          {progress.accountId ? ` · ${progress.accountId}` : ""}
          {` · ${progress.currentTitle ?? "正在准备"}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 md:grid-cols-2">
        <div className="space-y-2">
          <div className="flex justify-between text-xs font-medium">
            <span>导入素材库</span>
            <span className="font-data">
              {progress.materialCompleted ?? 0}/{progress.materialTotal ?? 0}
            </span>
          </div>
          <SegmentedProgress
            success={progress.materialSuccess}
            skipped={progress.materialSkipped}
            failed={progress.materialFailed}
            total={progress.materialTotal}
            label="导入素材库进度"
          />
        </div>
        <div className="space-y-2">
          <div className="flex justify-between text-xs font-medium">
            <span>发布商品</span>
            <span className="font-data">
              {progress.publishCompleted ?? 0}/{progress.publishTotal ?? 0}
            </span>
          </div>
          <SegmentedProgress
            success={progress.publishSuccess}
            skipped={progress.publishSkipped}
            failed={progress.publishFailed}
            total={progress.publishTotal}
            label="发布商品进度"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function SelectedGamesDialog({
  open,
  onOpenChange,
  notify,
  onStarted,
  initialGameIds = [],
  accountIds = [],
  onSelected = null,
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, pageCount: 1 });
  const [selectedGameIds, setSelectedGameIds] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const initialSelectionKey = Array.isArray(initialGameIds)
    ? initialGameIds.join(",")
    : "";
  const isScheduleSelection = typeof onSelected === "function";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const parameters = new URLSearchParams({
        page: String(page),
        pageSize: "20",
        query,
        validOnly: "true",
      });
      setData(await api(`/api/games?${parameters}`));
    } catch (caught) {
      notify(errorMessage(caught), "error");
    } finally {
      setLoading(false);
    }
  }, [page, query, notify]);

  useEffect(() => {
    if (!open) return;
    setSelectedGameIds(new Set(initialGameIds));
    void load();
  }, [open, load, initialSelectionKey]);

  const currentPageGameIds = useMemo(
    () => data.items.map((game) => game.id),
    [data.items],
  );
  const selectedCurrentPageCount = currentPageGameIds.filter((gameId) =>
    selectedGameIds.has(gameId),
  ).length;
  const isCurrentPageSelected =
    currentPageGameIds.length > 0 &&
    selectedCurrentPageCount === currentPageGameIds.length;

  function toggleGameSelection(gameId, checked) {
    setSelectedGameIds((current) => {
      const next = new Set(current);
      if (checked) next.add(gameId);
      else next.delete(gameId);
      return next;
    });
  }

  function toggleCurrentPageSelection(checked) {
    setSelectedGameIds((current) => {
      const next = new Set(current);
      for (const gameId of currentPageGameIds) {
        if (checked) next.add(gameId);
        else next.delete(gameId);
      }
      return next;
    });
  }

  function closeDialog() {
    setSelectedGameIds(new Set());
    setQuery("");
    setPage(1);
    onOpenChange(false);
  }

  async function syncSelectedGames() {
    const gameIds = [...selectedGameIds];
    if (!gameIds.length) return;
    if (isScheduleSelection) {
      onSelected(gameIds);
      closeDialog();
      return;
    }
    setSyncing(true);
    try {
      const result = await api("/api/games/sync-selected", {
        method: "POST",
        body: jsonBody({ gameIds, accountIds }),
      });
      notify(result.message ?? `已启动 ${gameIds.length} 个有效游戏的同步任务`);
      closeDialog();
      await onStarted();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true);
        else closeDialog();
      }}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {isScheduleSelection ? "选择定时强制发布游戏" : "选择有效游戏同步"}
          </DialogTitle>
          <DialogDescription>
            {isScheduleSelection
              ? "仅显示同时具备有效图片链接和下载资源的游戏。定时执行时会先查询闲鱼实际商品，已存在的商品不会重复发布。"
              : "仅显示同时具备有效图片链接和下载资源的游戏，可跨页累计选择。"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="搜索游戏名称或游戏 ID"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="success">已选 {selectedGameIds.size} 个</Badge>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              刷新
            </Button>
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 text-center">
                  <input
                    type="checkbox"
                    className="h-4 w-4 align-middle accent-primary"
                    aria-label="选择本页所有有效游戏"
                    checked={isCurrentPageSelected}
                    disabled={!currentPageGameIds.length}
                    onChange={(event) =>
                      toggleCurrentPageSelection(event.target.checked)
                    }
                  />
                </TableHead>
                <TableHead>游戏</TableHead>
                <TableHead>下载源</TableHead>
                <TableHead>售价</TableHead>
                <TableHead>来源更新</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((game) => (
                <TableRow key={game.id}>
                  <TableCell className="w-12 text-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4 align-middle accent-primary"
                      aria-label={`选择游戏 ${game.title}`}
                      checked={selectedGameIds.has(game.id)}
                      onChange={(event) =>
                        toggleGameSelection(game.id, event.target.checked)
                      }
                    />
                  </TableCell>
                  <TableCell className="max-w-md">
                    <p className="line-clamp-2 font-medium">{game.title}</p>
                    <p className="font-data mt-1 text-[10px] text-muted-foreground">
                      ID {game.id}
                    </p>
                  </TableCell>
                  <TableCell>{game.downloadCount} 个</TableCell>
                  <TableCell>¥ {game.effectivePrice}</TableCell>
                  <TableCell>{formatDate(game.sourceUpdatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!loading && !data.items.length ? (
            <div className="p-6">
              <EmptyState
                title="没有匹配的有效游戏"
                description="可调整关键词，或先运行采集任务补齐图片和下载资源。"
              />
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-data text-xs text-muted-foreground">
            共 {formatNumber(data.total)} 个有效游戏 · 第 {data.page ?? page} / {data.pageCount ?? 1} 页
          </p>
          <div className="flex flex-wrap gap-2">
            {selectedGameIds.size ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedGameIds(new Set())}
              >
                清空选择
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((current) => current - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.pageCount || loading}
              onClick={() => setPage((current) => current + 1)}
            >
              下一页
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              disabled={!selectedGameIds.size || syncing}
              onClick={syncSelectedGames}
            >
              {syncing ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                isScheduleSelection ? <Check className="h-4 w-4" /> : <Play className="h-4 w-4" />
              )}
              {isScheduleSelection
                ? `保存所选 ${selectedGameIds.size} 个`
                : `同步所选 ${selectedGameIds.size} 个`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function syncTaskDraft(accountId, template = {}) {
  return {
    accountId,
    enabled: false,
    cronSchedule: template.cronSchedule ?? "0 8 * * *",
    mode: template.mode ?? "pending",
    gameIds: [],
    materialConcurrency: template.materialConcurrency ?? 4,
    publishBatchSize: template.publishBatchSize ?? 20,
    publishLimit: template.publishLimit ?? 0,
    sort: template.sort ?? "created",
    nextRun: null,
  };
}

function mergeAccountSyncTasks(schedule, accounts) {
  if (!schedule?.sync) return schedule;
  const savedTasks = schedule.sync.tasks ?? [];
  const savedByAccount = new Map(
    savedTasks.map((task) => [task.accountId, task]),
  );
  const template = savedTasks[0] ?? {};
  const accountIds = [
    ...new Set([
      ...accounts.map((account) => account.accountId),
      ...savedTasks.map((task) => task.accountId),
    ]),
  ].filter(Boolean);
  return {
    ...schedule,
    sync: {
      ...schedule.sync,
      accountIds,
      tasks: accountIds.map(
        (accountId) =>
          savedByAccount.get(accountId) ?? syncTaskDraft(accountId, template),
      ),
    },
  };
}

function TasksPage({ notify }) {
  const [schedule, setSchedule] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [runs, setRuns] = useState([]);
  const [logs, setLogs] = useState([]);
  const [saving, setSaving] = useState(false);
  const [logTask, setLogTask] = useState(null);
  const [controlAction, setControlAction] = useState(null);
  const [selectedGamesOpen, setSelectedGamesOpen] = useState(false);
  const [scheduledGamesOpen, setScheduledGamesOpen] = useState(false);
  const [selectedScheduleAccountId, setSelectedScheduleAccountId] =
    useState("");
  const scheduleDirtyRef = useRef(false);
  const scheduleRevisionRef = useRef(0);

  const load = useCallback(async () => {
    const [nextSchedule, nextRuns, nextLogs, accountPayload] =
      await Promise.all([
        api("/api/settings/schedule"),
        api("/api/runs?limit=50"),
        api("/api/logs?limit=80"),
        api("/api/xianyu/accounts").catch(() => null),
      ]);
    const nextAccounts = accountPayload?.items ?? [];
    if (!scheduleDirtyRef.current) {
      const mergedSchedule = mergeAccountSyncTasks(
        nextSchedule,
        nextAccounts,
      );
      setSchedule(mergedSchedule);
      setSelectedScheduleAccountId((current) => {
        const taskIds = mergedSchedule?.sync?.tasks?.map(
          (task) => task.accountId,
        ) ?? [];
        return taskIds.includes(current) ? current : taskIds[0] ?? "";
      });
    }
    if (accountPayload) setAccounts(nextAccounts);
    setRuns(nextRuns);
    setLogs(nextLogs);
  }, []);
  usePolling(load);

  function updateSchedule(path, value) {
    scheduleDirtyRef.current = true;
    scheduleRevisionRef.current += 1;
    setSchedule((current) => {
      const next = structuredClone(current);
      if (path.length === 1) next[path[0]] = value;
      else next[path[0]][path[1]] = value;
      return next;
    });
  }

  function updateSyncTask(accountId, key, value) {
    scheduleDirtyRef.current = true;
    scheduleRevisionRef.current += 1;
    setSchedule((current) => ({
      ...current,
      sync: {
        ...current.sync,
        tasks: current.sync.tasks.map((task) =>
          task.accountId === accountId ? { ...task, [key]: value } : task,
        ),
      },
    }));
  }

  async function saveSchedule() {
    const savedRevision = scheduleRevisionRef.current;
    setSaving(true);
    try {
      await api("/api/settings/schedule", {
        method: "PUT",
        body: jsonBody({
          cron_timezone: schedule.cronTimezone,
          crawl: {
            enabled: schedule.crawl.enabled,
            cron_schedule: schedule.crawl.cronSchedule,
            concurrency: Number(schedule.crawl.concurrency),
          },
          sync: {
            tasks: (schedule.sync.tasks ?? []).map((task) => ({
              account_id: task.accountId,
              enabled: task.enabled,
              cron_schedule: task.cronSchedule,
              mode: task.mode,
              material_concurrency: Number(task.materialConcurrency),
              publish_batch_size: Number(task.publishBatchSize),
              publish_limit: Number(task.publishLimit),
              sort: task.sort,
              selected_game_ids: task.gameIds ?? [],
            })),
          },
        }),
      });
      if (scheduleRevisionRef.current === savedRevision) {
        scheduleDirtyRef.current = false;
      }
      notify("定时任务配置已保存");
      await load();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    } finally {
      setSaving(false);
    }
  }

  async function runTask(kind, mode, { useConfiguredTask = false } = {}) {
    try {
      await api(kind === "crawl" ? "/api/crawl/run" : "/api/sync/run", {
        method: "POST",
        body: jsonBody(
          kind === "sync"
            ? {
                ...(useConfiguredTask
                  ? { use_configured_task: true }
                  : { mode }),
                account_ids: selectedScheduleAccountId
                  ? [selectedScheduleAccountId]
                  : [],
              }
            : {},
        ),
      });
      notify(
        kind === "crawl"
          ? "采集任务已启动"
          : useConfiguredTask
            ? "已按设定启动同步任务"
            : "同步任务已启动",
      );
      await load();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    }
  }

  async function control(kind, action) {
    if (controlAction) return;
    setControlAction(action);
    try {
      await api(`/api/tasks/${kind}/${action}`, {
        method: "POST",
        body: jsonBody({}),
      });
      notify(
        action === "pause"
          ? "任务已立即暂停"
          : action === "terminate"
            ? "任务已终止"
            : "任务已恢复执行",
      );
      await load();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    } finally {
      setControlAction(null);
    }
  }

  const selectedSyncTask = schedule?.sync?.tasks?.find(
    (task) => task.accountId === selectedScheduleAccountId,
  );
  const selectedSyncAccount = accounts.find(
    (account) => account.accountId === selectedScheduleAccountId,
  );
  const selectedSyncAccountUsable = selectedSyncAccount?.enabled !== false;

  return (
    <>
      <PageHeading
        eyebrow="Scheduler & records"
        title="任务"
        description="配置定时采集和同步，手动执行任务，并在同一页面查看任务记录与错误日志。"
        actions={
          <>
            <Button variant="outline" onClick={() => runTask("crawl")}>
              <CloudDownload className="h-4 w-4" />
              立即采集
            </Button>
            <Button
              onClick={() =>
                runTask("sync", null, { useConfiguredTask: true })
              }
              disabled={!selectedSyncTask || !selectedSyncAccountUsable}
            >
              <Play className="h-4 w-4" />
              立即执行同步任务
            </Button>
          </>
        }
      />
      <TaskProgress
        schedule={schedule}
        crawlRun={runs.find(
          (run) => run.taskType === "crawl" && run.status === "running",
        )}
        onViewLogs={setLogTask}
      />
      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>定时配置</CardTitle>
            <CardDescription>保存后立即重载 Cron 计划。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label>任务时区</Label>
              <Input
                value={schedule?.cronTimezone ?? ""}
                onChange={(event) =>
                  updateSchedule(["cronTimezone"], event.target.value)
                }
              />
            </div>
            <Separator />
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">采集任务</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    下次执行 {formatDate(schedule?.crawl?.nextRun)}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={Boolean(schedule?.crawl?.enabled)}
                    onChange={(event) =>
                      updateSchedule(["crawl", "enabled"], event.target.checked)
                    }
                  />
                  启用
                </label>
              </div>
              <Input
                className="font-data"
                value={schedule?.crawl?.cronSchedule ?? ""}
                onChange={(event) =>
                  updateSchedule(["crawl", "cronSchedule"], event.target.value)
                }
              />
              <p className="text-xs text-muted-foreground">
                Cron 格式为“分 时 日 月 周”。每天 08:00 执行一次请填写
                <span className="font-data"> 0 8 * * *</span>；
                <span className="font-data"> * 8 * * *</span> 会在 08:00–08:59 每分钟执行一次。
              </p>
              <div className="space-y-2">
                <Label>详情采集并行数</Label>
                <Input
                  type="number"
                  min="1"
                  max="12"
                  value={schedule?.crawl?.concurrency ?? 3}
                  onChange={(event) =>
                    updateSchedule(["crawl", "concurrency"], event.target.value)
                  }
                />
                <p className="text-xs text-muted-foreground">
                  可配置 1–12，调高会增加目标站点访问压力。
                </p>
              </div>
            </div>
            <Separator />
            <div className="space-y-4">
              <div>
                <p className="text-sm font-semibold">账号同步任务</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  每个发布账号有一条独立的定时任务；点击账号后配置该账号的运行时间和同步参数。
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {(schedule?.sync?.tasks ?? []).map((task) => {
                  const account = accounts.find(
                    (item) => item.accountId === task.accountId,
                  );
                  const selected = task.accountId === selectedScheduleAccountId;
                  return (
                    <button
                      type="button"
                      key={task.accountId}
                      className={cn(
                        "rounded-lg border p-3 text-left text-sm transition",
                        selected && "border-blue-300 bg-blue-50/60",
                        account && !account.enabled && "opacity-50",
                      )}
                      onClick={() => setSelectedScheduleAccountId(task.accountId)}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium">
                          {account?.remark || task.accountId}
                        </span>
                        <Badge tone={task.enabled ? "success" : "neutral"}>
                          {task.enabled ? "已启用" : "未启用"}
                        </Badge>
                      </span>
                      <span className="font-data mt-1 block truncate text-[10px] text-muted-foreground">
                        {task.accountId}
                      </span>
                      <span className="mt-2 block text-xs text-muted-foreground">
                        下次执行 {formatDate(task.nextRun)}
                      </span>
                    </button>
                  );
                })}
              </div>
              {!selectedSyncTask ? (
                <p className="text-sm text-muted-foreground">
                  暂无账号任务，请先配置闲鱼 API Key。
                </p>
              ) : (
                <div className="space-y-4 rounded-xl border bg-slate-50/50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">
                        {selectedSyncAccount?.remark || selectedSyncTask.accountId}
                      </p>
                      <p className="font-data mt-1 text-[10px] text-muted-foreground">
                        {selectedSyncTask.accountId}
                      </p>
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={Boolean(selectedSyncTask.enabled)}
                        disabled={
                          selectedSyncAccount?.enabled === false &&
                          !selectedSyncTask.enabled
                        }
                        onChange={(event) =>
                          updateSyncTask(
                            selectedSyncTask.accountId,
                            "enabled",
                            event.target.checked,
                          )
                        }
                      />
                      启用
                    </label>
                  </div>
                  <Input
                    className="font-data"
                    value={selectedSyncTask.cronSchedule}
                    onChange={(event) =>
                      updateSyncTask(
                        selectedSyncTask.accountId,
                        "cronSchedule",
                        event.target.value,
                      )
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Cron 格式为“分 时 日 月 周”，只影响当前账号任务。
                  </p>
                  <Select
                    value={selectedSyncTask.mode}
                    onChange={(event) =>
                      updateSyncTask(
                        selectedSyncTask.accountId,
                        "mode",
                        event.target.value,
                      )
                    }
                  >
                    <option value="pending">未发布商品</option>
                    <option value="all">全部待处理商品</option>
                    <option value="updated">已更新商品</option>
                    <option value="selected-force">自选游戏强制发布</option>
                  </Select>
                  {selectedSyncTask.mode === "selected-force" ? (
                    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <Label>定时自选游戏</Label>
                          <p className="mt-1 text-xs text-muted-foreground">
                            已选 {selectedSyncTask.gameIds?.length ?? 0} 个，仅用于当前账号任务。
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setScheduledGamesOpen(true)}
                        >
                          <Check className="h-4 w-4" />
                          选择游戏
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    <Label>同步排序</Label>
                    <Select
                      value={selectedSyncTask.sort}
                      onChange={(event) =>
                        updateSyncTask(
                          selectedSyncTask.accountId,
                          "sort",
                          event.target.value,
                        )
                      }
                    >
                      <option value="created">创建时间从早到晚</option>
                      <option value="updated">更新时间从早到晚</option>
                      <option value="hot">热度从高到低</option>
                    </Select>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label>素材导入并行数</Label>
                      <Input
                        type="number"
                        min="1"
                        max="12"
                        value={selectedSyncTask.materialConcurrency}
                        onChange={(event) =>
                          updateSyncTask(
                            selectedSyncTask.accountId,
                            "materialConcurrency",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>每批发布商品数</Label>
                      <Input
                        type="number"
                        min="1"
                        max="20"
                        value={selectedSyncTask.publishBatchSize}
                        onChange={(event) =>
                          updateSyncTask(
                            selectedSyncTask.accountId,
                            "publishBatchSize",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>定时发布成功上限</Label>
                      <Input
                        type="number"
                        min="0"
                        max="100000"
                        value={selectedSyncTask.publishLimit}
                        onChange={(event) =>
                          updateSyncTask(
                            selectedSyncTask.accountId,
                            "publishLimit",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    所有账号共用商品配置；Cron、同步范围、排序、并行数、批量数量和发布上限按账号分别保存。发布上限填 0 表示不限制。
                  </p>
                </div>
              )}
            </div>
            <Button className="w-full" onClick={saveSchedule} disabled={saving}>
              <Save className="h-4 w-4" />
              {saving ? "正在保存" : "保存定时配置"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>手动操作</CardTitle>
            <CardDescription>
              对当前选中的账号启动同步。暂停后可以恢复；终止会真正结束当前任务且不能恢复。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Button
                variant="outline"
                onClick={() => runTask("sync", "all")}
                disabled={!selectedSyncTask || !selectedSyncAccountUsable}
              >
                全部待处理商品
              </Button>
              <Button
                variant="outline"
                onClick={() => runTask("sync", "pending")}
                disabled={!selectedSyncTask || !selectedSyncAccountUsable}
              >
                未发布商品
              </Button>
              <Button
                variant="outline"
                onClick={() => runTask("sync", "updated")}
                disabled={!selectedSyncTask || !selectedSyncAccountUsable}
              >
                已更新商品
              </Button>
              <Button
                onClick={() => setSelectedGamesOpen(true)}
                disabled={!selectedSyncTask || !selectedSyncAccountUsable}
              >
                <Check className="h-4 w-4" />
                自选有效游戏
              </Button>
            </div>
            <Separator />
            <div className="grid gap-3 sm:grid-cols-3">
              <Button
                variant="secondary"
                onClick={() =>
                  control(
                    schedule?.sync?.active ? "sync" : "crawl",
                    "pause",
                  )
                }
                disabled={
                  Boolean(controlAction) ||
                  (!schedule?.crawl?.active &&
                    !schedule?.sync?.active)
                }
              >
                {controlAction === "pause" ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Pause className="h-4 w-4" />
                )}
                {controlAction === "pause"
                  ? "正在暂停"
                  : "暂停当前任务"}
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  control(
                    schedule?.sync?.interrupted ? "sync" : "crawl",
                    "resume",
                  )
                }
                disabled={
                  Boolean(controlAction) ||
                  (!schedule?.crawl?.interrupted &&
                    !schedule?.sync?.interrupted)
                }
              >
                {controlAction === "resume" ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                {controlAction === "resume"
                  ? "正在恢复"
                  : "恢复任务"}
              </Button>
              <Button
                variant="destructive"
                onClick={() =>
                  control(
                    schedule?.sync?.active ? "sync" : "crawl",
                    "terminate",
                  )
                }
                disabled={
                  Boolean(controlAction) ||
                  (!schedule?.crawl?.active &&
                    !schedule?.sync?.active)
                }
              >
                {controlAction === "terminate" ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
                {controlAction === "terminate"
                  ? "正在终止"
                  : "终止当前任务"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>任务记录</CardTitle>
          <CardDescription>采集和同步任务按开始时间倒序排列。</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>任务</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>处理结果</TableHead>
                <TableHead>跳过</TableHead>
                <TableHead>开始时间</TableHead>
                <TableHead>说明</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={`${run.taskType}-${run.id}`}>
                  <TableCell>
                    <div className="font-medium">
                      {run.taskType === "crawl" ? "采集" : "同步"} #{run.id}
                    </div>
                    <div className="font-data mt-1 text-[10px] text-muted-foreground">
                      {run.triggerType}
                      {run.accountId ? ` · ${run.accountId}` : ""}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={run.status} />
                  </TableCell>
                  <TableCell>
                    {run.taskType === "crawl"
                      ? `${run.detailSucceeded ?? 0} 成功 / ${run.detailFailed ?? 0} 失败`
                      : `${run.publishSuccess ?? 0} 发布 / ${run.publishFailed ?? 0} 失败`}
                  </TableCell>
                  <TableCell>
                    {run.taskType === "crawl"
                      ? run.detailSkipped ?? 0
                      : run.materialSkipped ?? 0}
                  </TableCell>
                  <TableCell>{formatDate(run.startedAt)}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {run.errorSummary ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setLogTask(run)}
                    >
                      <ScrollText className="h-3.5 w-3.5" />
                      日志
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>日志记录</CardTitle>
          <CardDescription>采集错误和同步异常集中展示。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {logs.length ? (
            logs.map((log) => (
              <div
                key={log.id}
                className="grid gap-2 rounded-lg border p-3 md:grid-cols-[110px_90px_1fr_120px] md:items-center"
              >
                <Badge tone={log.level === "error" ? "danger" : "warning"}>
                  {log.taskType === "crawl" ? "采集" : "同步"} #{log.runId}
                </Badge>
                <span className="font-data text-xs text-muted-foreground">
                  {log.stage}
                </span>
                <span className="text-sm">{log.message}</span>
                <span className="font-data text-[10px] text-muted-foreground">
                  {formatDate(log.createdAt)}
                </span>
              </div>
            ))
          ) : (
            <EmptyState title="没有日志" description="暂未记录任务异常。" />
          )}
        </CardContent>
      </Card>
      <SelectedGamesDialog
        open={selectedGamesOpen}
        onOpenChange={setSelectedGamesOpen}
        notify={notify}
        onStarted={load}
        accountIds={selectedScheduleAccountId ? [selectedScheduleAccountId] : []}
      />
      <SelectedGamesDialog
        open={scheduledGamesOpen}
        onOpenChange={setScheduledGamesOpen}
        notify={notify}
        onStarted={load}
        initialGameIds={selectedSyncTask?.gameIds ?? []}
        onSelected={(gameIds) => {
          if (selectedSyncTask) {
            updateSyncTask(selectedSyncTask.accountId, "gameIds", gameIds);
            notify("当前账号的定时自选游戏已更新，请保存定时配置");
          }
        }}
      />
      <TaskLogDialog
        task={logTask}
        open={Boolean(logTask)}
        onOpenChange={(open) => {
          if (!open) setLogTask(null);
        }}
      />
    </>
  );
}

function ProductConfigPage({ notify }) {
  const [settings, setSettings] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [cards, setCards] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useRememberedAccountId(
    productConfigAccountStorageKey,
  );
  const [capability, setCapability] = useState(null);
  const [fishSpecificationsText, setFishSpecificationsText] = useState("[]");
  const [fishSkuRowsText, setFishSkuRowsText] = useState("[]");
  const [platformAttributesText, setPlatformAttributesText] = useState("[]");
  const [previewImageFailed, setPreviewImageFailed] = useState(false);

  const load = useCallback(async () => {
    const [payload, cardPayload] = await Promise.all([
      api("/api/xianyu/accounts"),
      api("/api/xianyu/cards"),
    ]);
    const items = payload.items ?? [];
    setAccounts(items);
    setCards(cardPayload.items ?? []);
    setSelectedAccountId((current) =>
      items.some((account) => account.accountId === current)
        ? current
        : items.find((account) => account.enabled)?.accountId ?? items[0]?.accountId ?? "",
    );
  }, []);
  useEffect(() => {
    void load().catch((caught) => notify(errorMessage(caught), "error"));
  }, [load]);

  const loadAccountSettings = useCallback(async (accountId) => {
    if (!accountId) {
      setSettings(null);
      setCapability(null);
      return;
    }
    const [nextSettings, nextCapability] = await Promise.all([
      api(`/api/settings/xianyu?accountId=${encodeURIComponent(accountId)}`),
      api(`/api/xianyu/accounts/capability?accountId=${encodeURIComponent(accountId)}`),
    ]);
    setSettings(nextSettings);
    setCapability(nextCapability);
    setFishSpecificationsText(
      JSON.stringify(nextSettings.publishOptions?.fish?.specifications ?? [], null, 2),
    );
    setFishSkuRowsText(
      JSON.stringify(nextSettings.publishOptions?.fish?.skuRows ?? [], null, 2),
    );
    setPlatformAttributesText(
      JSON.stringify(nextSettings.publishOptions?.platformAttributes ?? [], null, 2),
    );
  }, []);
  useEffect(() => {
    void loadAccountSettings(selectedAccountId).catch((caught) => {
      setSettings(null);
      setCapability(null);
      notify(errorMessage(caught), "error");
    });
  }, [loadAccountSettings, selectedAccountId]);

  function update(key, value) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function updatePublishOption(key, value) {
    setSettings((current) => ({
      ...current,
      publishOptions: {
        ...current.publishOptions,
        [key]: value,
      },
    }));
  }

  function updateFishOption(key, value) {
    setSettings((current) => ({
      ...current,
      publishOptions: {
        ...current.publishOptions,
        fish: {
          ...current.publishOptions.fish,
          [key]: value,
        },
      },
    }));
  }

  function parseJson(value, label) {
    try {
      const parsed = JSON.parse(value || "[]");
      if (!Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch {
      throw new Error(`${label}必须是 JSON 数组`);
    }
  }

  async function save() {
    try {
      const publishOptions = {
        ...settings.publishOptions,
        fish: {
          ...settings.publishOptions.fish,
          quantity: Number(settings.publishOptions.fish.quantity),
          specifications: parseJson(fishSpecificationsText, "规格"),
          skuRows: parseJson(fishSkuRowsText, "SKU"),
        },
        platformAttributes: parseJson(platformAttributesText, "平台属性"),
      };
      await api("/api/settings/xianyu", {
        method: "PUT",
        body: jsonBody({
          account_id: selectedAccountId,
          default_price: Number(settings.defaultPrice),
          default_stock: Number(publishOptions.fish.quantity),
          title_template: settings.titleTemplate,
          description_template: settings.descriptionTemplate,
          image_template: settings.imageTemplate,
          publish_options: publishOptions,
        }),
      });
      notify("商品配置已保存");
      await loadAccountSettings(selectedAccountId);
    } catch (caught) {
      notify(errorMessage(caught), "error");
    }
  }

  const isFishShop = capability?.account_type === "fish-shop";
  const publishOptions = settings?.publishOptions ?? {
    cardId: null,
    originalPrice: null,
    category: "虚拟商品",
    condition: "全新",
    deliveryMethod: "express",
    shippingMethod: "free",
    postage: 0,
    address: "",
    addressExpectedText: "",
    supportPickup: false,
    brand: "",
    platformAttributes: [],
    fish: { quantity: 999, specifications: [], skuRows: [] },
  };
  const shippingMethods = capability?.supports?.shipping_methods ?? ["free"];
  const shippingLabels = {
    free: "包邮",
    distance: "按距离计费",
    fixed: "固定邮费",
    none: "无需物流",
  };

  const preview = useMemo(() => {
    if (!settings) return null;
    const sample = settings.preview ?? {};
    const values = {
      title: sample.title ?? "赛博朋克 2077 终极版",
      id: String(sample.id ?? "4121"),
      description:
        sample.description ?? "夜之城开放世界动作角色扮演游戏。",
      cloud_drives: sample.cloudDrives ?? "百度 / 夸克",
      price: settings.defaultPrice ?? 1,
      image_url:
        sample.imageUrl ?? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='450'%3E%3Crect width='100%25' height='100%25' fill='%23e2e8f0'/%3E%3C/svg%3E",
    };
    const render = (template) =>
      String(template ?? "").replace(
        /\{([a-z_]+)\}/g,
        (_match, key) => values[key] ?? `{${key}}`,
      );
    return {
      title: render(settings.titleTemplate),
      description: render(settings.descriptionTemplate),
      image: render(settings.imageTemplate),
    };
  }, [settings]);

  useEffect(() => {
    setPreviewImageFailed(false);
  }, [preview?.image]);

  return (
    <>
      <PageHeading
        eyebrow="Listing rules"
        title="商品配置"
        description="每个账号单独保存可发布参数；分类会按该账号自动推荐并写入素材。"
        actions={
          <Button onClick={save} disabled={!settings || !selectedAccountId}>
            <Save className="h-4 w-4" />
            保存配置
          </Button>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>发布设置</CardTitle>
            <CardDescription>占位符会在同步素材时替换；字段以当前账号的批量发布能力为准。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>配置账号</Label>
                <Select
                  value={selectedAccountId}
                  onChange={(event) => setSelectedAccountId(event.target.value)}
                >
                  <option value="">请选择账号</option>
                  {accounts.map((account) => (
                    <option key={account.accountId} value={account.accountId}>
                      {account.remark || account.accountId}{account.enabled ? "" : "（已停用）"}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label>账号类型</Label>
                <div className="flex h-10 items-center rounded-md border px-3">
                  {capability ? (
                    <Badge tone={isFishShop ? "info" : "success"}>
                      {isFishShop ? "鱼小铺账号" : "普通账号"}
                    </Badge>
                  ) : (
                    <span className="text-sm text-muted-foreground">选择账号后自动识别</span>
                  )}
                </div>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>默认售价</Label>
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={settings?.defaultPrice ?? 1}
                  onChange={(event) =>
                    update("defaultPrice", event.target.value)
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>绑定卡券（可选）</Label>
                <Select
                  value={
                    publishOptions.cardId == null
                      ? ""
                      : String(publishOptions.cardId)
                  }
                  onChange={(event) =>
                    updatePublishOption(
                      "cardId",
                      event.target.value ? Number(event.target.value) : null,
                    )
                  }
                >
                  <option value="">不绑定卡券</option>
                  {cards.map((card) => (
                    <option
                      key={card.id}
                      value={card.id}
                      disabled={!card.enabled}
                    >
                      #{card.id} · {card.name}
                      {card.type ? `（${card.type}）` : ""}
                      {card.enabled ? "" : "（已停用）"}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-muted-foreground">
                  卡券来自 xianyu-auto-reply；不绑定时，后续发布不会自动关联卡券。
                </p>
              </div>
              <div className="space-y-2">
                <Label>原价（可选）</Label>
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={publishOptions.originalPrice ?? ""}
                  onChange={(event) =>
                    updatePublishOption("originalPrice", event.target.value)
                  }
                />
              </div>
            </div>
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">发布通道</p>
              <p className="mt-1">
                {isFishShop
                  ? "鱼小铺可设置库存、规格和 SKU；运费方式仅能使用包邮或无需物流。"
                  : "普通账号按个人卖家通道发布，不会传递库存、规格或 SKU。"}
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>业务分类</Label>
                <Input
                  value={publishOptions.category ?? ""}
                  onChange={(event) => updatePublishOption("category", event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>成色</Label>
                <Input
                  value={publishOptions.condition ?? "全新"}
                  onChange={(event) => updatePublishOption("condition", event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>发货方式</Label>
                <Select
                  value={publishOptions.deliveryMethod ?? "express"}
                  onChange={(event) => updatePublishOption("deliveryMethod", event.target.value)}
                >
                  <option value="express">快递发货</option>
                  <option value="pickup">上门自提</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>运费方式</Label>
                <Select
                  value={publishOptions.shippingMethod ?? "free"}
                  onChange={(event) => updatePublishOption("shippingMethod", event.target.value)}
                >
                  {shippingMethods.map((method) => (
                    <option key={method} value={method}>
                      {shippingLabels[method] ?? method}
                    </option>
                  ))}
                </Select>
              </div>
              {publishOptions.shippingMethod === "fixed" ? (
                <div className="space-y-2">
                  <Label>固定邮费</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={publishOptions.postage ?? 0}
                    onChange={(event) => updatePublishOption("postage", event.target.value)}
                  />
                </div>
              ) : null}
              <div className="space-y-2">
                <Label>宝贝所在地</Label>
                <Input
                  value={publishOptions.address ?? ""}
                  placeholder="发布前必须填写可识别的所在地"
                  onChange={(event) => updatePublishOption("address", event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>所在地期望文本（可选）</Label>
                <Input
                  value={publishOptions.addressExpectedText ?? ""}
                  onChange={(event) => updatePublishOption("addressExpectedText", event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>品牌（可选）</Label>
                <Input
                  value={publishOptions.brand ?? ""}
                  onChange={(event) => updatePublishOption("brand", event.target.value)}
                />
              </div>
              {!isFishShop ? (
                <label className="flex items-center gap-2 self-end pb-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={Boolean(publishOptions.supportPickup)}
                    onChange={(event) => updatePublishOption("supportPickup", event.target.checked)}
                  />
                  支持自提
                </label>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label>平台属性（JSON 数组，可选）</Label>
              <Textarea
                rows={4}
                value={platformAttributesText}
                onChange={(event) => setPlatformAttributesText(event.target.value)}
                placeholder={'[{"property_id":"","property_name":"","value_id":"","value_name":""}]'}
              />
              <p className="text-xs text-muted-foreground">
                平台分类会自动推荐；仅在该分类要求额外属性时填写，字段将原样传给批量发布素材。
              </p>
            </div>
            {isFishShop ? (
              <div className="space-y-4 rounded-lg border border-sky-200 bg-sky-50/40 p-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>库存</Label>
                    <Input
                      type="number"
                      min="1"
                      max="999999"
                      step="1"
                      value={publishOptions.fish?.quantity ?? 999}
                      onChange={(event) => updateFishOption("quantity", event.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>规格（JSON 数组）</Label>
                  <Textarea
                    rows={5}
                    value={fishSpecificationsText}
                    onChange={(event) => setFishSpecificationsText(event.target.value)}
                    placeholder={'[{"name":"版本","values":[{"name":"标准版"}]}]'}
                  />
                </div>
                <div className="space-y-2">
                  <Label>SKU（JSON 数组）</Label>
                  <Textarea
                    rows={5}
                    value={fishSkuRowsText}
                    onChange={(event) => setFishSkuRowsText(event.target.value)}
                    placeholder={'[{"specs":{"版本":"标准版"},"price":1,"stock":999}]'}
                  />
                </div>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label>标题模板</Label>
              <Input
                value={settings?.titleTemplate ?? ""}
                onChange={(event) =>
                  update("titleTemplate", event.target.value)
                }
              />
            </div>
            <div className="space-y-2">
              <Label>简介模板</Label>
              <Textarea
                rows={9}
                value={settings?.descriptionTemplate ?? ""}
                onChange={(event) =>
                  update("descriptionTemplate", event.target.value)
                }
              />
            </div>
            <div className="space-y-2">
              <Label>图片模板</Label>
              <Input
                value={settings?.imageTemplate ?? ""}
                onChange={(event) =>
                  update("imageTemplate", event.target.value)
                }
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                "{title}",
                "{id}",
                "{description}",
                "{cloud_drives}",
                "{price}",
                "{image_url}",
              ].map((placeholder) => (
                <Badge key={placeholder} tone="info" className="font-data">
                  {placeholder}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>模板预览</CardTitle>
            <CardDescription>使用示例数据预览最终素材。</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-xl border bg-white">
              <div className="aspect-[16/9] bg-slate-100">
                {preview?.image && !previewImageFailed ? (
                  <img
                    className="h-full w-full object-cover"
                    src={preview.image}
                    alt={preview.title}
                    onError={() => setPreviewImageFailed(true)}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                    当前图片无法加载，请检查图片模板或游戏图片链接
                  </div>
                )}
              </div>
              <div className="p-5">
                <div className="flex flex-wrap gap-2">
                  <Badge tone="success">¥ {settings?.defaultPrice ?? 1}</Badge>
                  {isFishShop ? (
                    <Badge tone="info">库存 {publishOptions.fish?.quantity ?? 999}</Badge>
                  ) : (
                    <Badge tone="info">普通账号</Badge>
                  )}
                </div>
                <h3 className="mt-3 text-lg font-semibold">
                  {preview?.title ?? "等待配置"}
                </h3>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                  {preview?.description ?? "保存模板后生成商品简介。"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function GameDetail({ gameId, accountId, open, onOpenChange, notify }) {
  const [detail, setDetail] = useState(null);
  const [imagePreviewFailed, setImagePreviewFailed] = useState(false);
  useEffect(() => {
    if (!open || !gameId) return;
    const parameters = new URLSearchParams();
    if (accountId) parameters.set("accountId", accountId);
    const suffix = parameters.size ? `?${parameters}` : "";
    void api(`/api/games/${gameId}${suffix}`).then(setDetail);
  }, [accountId, gameId, open]);
  useEffect(() => {
    setImagePreviewFailed(false);
  }, [detail?.game?.imageUrl]);

  async function copyDeliveryInfo() {
    const deliveryInfo = [
      `解压密码：${detail?.game?.archivePassword ?? ""}`,
      ...(detail?.downloads ?? []).map((download) => {
        const extractionCode = download.extractionCode ?? download.password;
        return `${download.provider}：${download.url}${
          extractionCode ? ` 提取码：${extractionCode}` : ""
        }`;
      }),
    ].join("\n");

    try {
      await navigator.clipboard.writeText(deliveryInfo);
      notify("手动发货信息已复制");
    } catch (caught) {
      notify(errorMessage(caught), "error");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="game-detail-copyable max-w-3xl">
        <DialogHeader>
          <DialogTitle>{detail?.game?.title ?? `游戏 ${gameId}`}</DialogTitle>
          <DialogDescription>
            游戏凭证、图片链接、下载源与资源详情页；移动端可长按文字复制。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">资源码</p>
            <p className="font-data mt-2 break-all text-sm">
              {detail?.game?.resourceCode ?? "—"}
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">解压密码</p>
            <p className="font-data mt-2 break-all text-sm">
              {detail?.game?.archivePassword ?? "—"}
            </p>
          </div>
        </div>
        {detail?.game?.imageUrl ? (
          <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_10rem] sm:items-center">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">图片链接</p>
              <a
                className="mt-2 block break-all text-sm text-primary hover:underline"
                href={detail.game.imageUrl}
                target="_blank"
                rel="noreferrer"
              >
                {detail.game.imageUrl}
              </a>
            </div>
            <a
              className="flex h-24 overflow-hidden rounded-md border bg-slate-50"
              href={`/api/games/${gameId}/cover`}
              target="_blank"
              rel="noreferrer"
              aria-label="在新标签页打开带来源页 Referer 的图片"
            >
              {imagePreviewFailed ? (
                <span className="flex w-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
                  图片预览加载失败
                </span>
              ) : (
                <img
                  className="h-full w-full object-cover"
                  src={`/api/games/${gameId}/cover`}
                  alt={`${detail.game.title} 封面预览`}
                  onError={() => setImagePreviewFailed(true)}
                />
              )}
            </a>
          </div>
        ) : null}
        <div className="space-y-3">
          {(detail?.downloads ?? []).map((download, index) => (
            <div key={`${download.url}-${index}`} className="rounded-lg border p-4">
              <div className="flex items-center justify-between gap-3">
                <Badge tone="info">{download.provider}</Badge>
                <span className="font-data text-xs text-muted-foreground">
                  提取码 {download.extractionCode ?? download.password ?? "—"}
                </span>
              </div>
              <a
                className="mt-3 block break-all text-sm text-primary hover:underline"
                href={download.url}
                target="_blank"
                rel="noreferrer"
              >
                {download.url}
              </a>
            </div>
          ))}
        </div>
        {detail?.game ? (
          <div className="flex flex-col items-start gap-2">
            <Button onClick={copyDeliveryInfo}>
              <Truck className="h-4 w-4" />
              手动发货
            </Button>
            {detail.game.detailPageUrl ? (
              <Button asChild variant="outline">
                <a
                  href={detail.game.detailPageUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="h-4 w-4" />
                  打开资源详情页
                </a>
              </Button>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PriceEditor({ game, onSaved, notify }) {
  const [price, setPrice] = useState(game.salePrice ?? "");
  async function save() {
    try {
      await api(`/api/games/${game.id}/price`, {
        method: "PUT",
        body: jsonBody({ price: price === "" ? null : Number(price) }),
      });
      notify(`游戏 ${game.id} 售价已保存`);
      await onSaved();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    }
  }
  return (
    <div className="flex min-w-32 items-center">
      <Input
        className="h-8 rounded-r-none"
        type="number"
        min="0.01"
        step="0.01"
        placeholder={String(game.effectivePrice)}
        value={price}
        onChange={(event) => setPrice(event.target.value)}
      />
      <Button
        className="h-8 rounded-l-none px-2"
        variant="outline"
        onClick={save}
        aria-label="保存售价"
      >
        <Save className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function GamesPage({ notify }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [xianyuStatus, setXianyuStatus] = useState("all");
  const [sort, setSort] = useState("hot");
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, pageCount: 1 });
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useRememberedAccountId(
    gamesAccountStorageKey,
  );
  const [detailId, setDetailId] = useState(null);
  const [syncingGameId, setSyncingGameId] = useState(null);
  const [syncingXianyuItems, setSyncingXianyuItems] = useState(false);
  const [updatingViolationGameId, setUpdatingViolationGameId] = useState(null);

  const load = useCallback(async () => {
    const parameters = new URLSearchParams({
      page: String(page),
      pageSize: "20",
      query,
      status,
      xianyuStatus,
      sort,
    });
    if (selectedAccountId) parameters.set("accountId", selectedAccountId);
    setData(await api(`/api/games?${parameters}`));
  }, [page, query, status, xianyuStatus, sort, selectedAccountId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    let active = true;
    void api("/api/xianyu/accounts")
      .then((payload) => {
        if (!active) return;
        const enabledAccounts = (payload.items ?? []).filter(
          (account) => account.enabled !== false,
        );
        setAccounts(enabledAccounts);
        setSelectedAccountId((current) =>
          enabledAccounts.some((account) => account.accountId === current)
            ? current
            : enabledAccounts[0]?.accountId ?? "",
        );
      })
      .catch((caught) => {
        if (active) notify(errorMessage(caught), "error");
      });
    return () => {
      active = false;
    };
  }, []);

  async function syncGame(gameId) {
    if (!selectedAccountId) {
      notify("请先选择要发布的闲鱼账号", "error");
      return;
    }
    setSyncingGameId(gameId);
    try {
      await api(`/api/games/${gameId}/sync`, {
        method: "POST",
        body: jsonBody({ account_id: selectedAccountId }),
      });
      notify(`游戏 ${gameId} 已向账号 ${selectedAccountId} 启动同步`);
    } catch (caught) {
      notify(errorMessage(caught), "error");
    } finally {
      setSyncingGameId(null);
    }
  }

  async function syncXianyuItems() {
    if (!selectedAccountId) {
      notify("请先选择要核对发布状态的闲鱼账号", "error");
      return;
    }
    setSyncingXianyuItems(true);
    try {
      const result = await api("/api/xianyu/items/sync", {
        method: "POST",
        body: jsonBody({ account_id: selectedAccountId }),
      });
      notify(
        `闲鱼状态核对完成：素材确认 ${result.materialConfirmedCount ?? 0} 个，失效 ${result.materialResetCount ?? 0} 个；商品确认发布 ${result.confirmedCount} 个（名称匹配 ${result.titleMatchedCount} 个），回退素材库 ${result.materialFallbackCount} 个`,
      );
      await load();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    } finally {
      setSyncingXianyuItems(false);
    }
  }

  async function updateViolationStatus(game) {
    const nextStatus =
      game.scrapeStatus === "violation" ? "success" : "violation";
    setUpdatingViolationGameId(game.id);
    try {
      await api(`/api/games/${game.id}/scrape-status`, {
        method: "PUT",
        body: jsonBody({ status: nextStatus }),
      });
      notify(
        nextStatus === "violation"
          ? `游戏 ${game.id} 已标记违规，不会再进入发布列表`
          : `游戏 ${game.id} 已恢复为采集成功`,
      );
      await load();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    } finally {
      setUpdatingViolationGameId(null);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="Catalog operations"
        title="游戏数据"
        description="检索游戏、调整售价、查看下载凭证，并单独触发某个游戏的同步。"
      />
      <Card>
        <CardContent className="p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_180px_160px]">
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="搜索名称、游戏 ID 或闲鱼商品 ID"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
              />
            </div>
            <Select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">全部采集状态</option>
              <option value="success">采集成功</option>
              <option value="updated">已更新</option>
              <option value="missing">缺失</option>
              <option value="violation">违规</option>
              <option value="failed">采集失败</option>
            </Select>
            <Select
              value={xianyuStatus}
              onChange={(event) => {
                setXianyuStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">全部闲鱼状态</option>
              <option value="publishable">可发布</option>
              <option value="none">无</option>
              <option value="material">加入素材库</option>
              <option value="publishing">发布中</option>
              <option value="published">发布成功</option>
            </Select>
            <Select
              value={sort}
              onChange={(event) => {
                setSort(event.target.value);
                setPage(1);
              }}
            >
              <option value="hot">按热度排序</option>
              <option value="created">按创建时间</option>
              <option value="updated">按更新时间</option>
            </Select>
          </div>
        </CardContent>
      </Card>
      <Card className="mt-5">
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>游戏列表</CardTitle>
            <CardDescription className="mt-1">
              {selectedAccountId
                ? `账号 ${selectedAccountId} · `
                : "正在加载发布账号 · "}
              共 {formatNumber(data.total)} 条
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="whitespace-nowrap">发布状态账号</span>
              <Select
                className="h-9 w-52"
                value={selectedAccountId}
                disabled={accounts.length === 0}
                onChange={(event) => {
                  setSelectedAccountId(event.target.value);
                  setPage(1);
                }}
              >
                {accounts.length === 0 ? (
                  <option value="">暂无可用账号</option>
                ) : (
                  accounts.map((account) => (
                    <option key={account.accountId} value={account.accountId}>
                      {account.remark
                        ? `${account.remark}（${account.accountId}）`
                        : account.accountId}
                    </option>
                  ))
                )}
              </Select>
            </label>
            <Button
              variant="outline"
              size="sm"
              disabled={syncingXianyuItems || !selectedAccountId}
              onClick={syncXianyuItems}
            >
              <RefreshCw
                className={cn("h-4 w-4", syncingXianyuItems && "animate-spin")}
              />
              查询发布状态
            </Button>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="h-4 w-4" />
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>游戏</TableHead>
                <TableHead>资源</TableHead>
                <TableHead>售价</TableHead>
                <TableHead>采集状态</TableHead>
                <TableHead>闲鱼状态</TableHead>
                <TableHead>最近更新</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((game) => (
                <TableRow key={game.id}>
                  <TableCell className="max-w-md">
                    <button
                      className="block max-w-full text-left"
                      onClick={() => setDetailId(game.id)}
                    >
                      <span className="line-clamp-2 font-medium hover:text-primary">
                        {game.title}
                      </span>
                      <span className="font-data mt-1 block text-[10px] text-muted-foreground">
                        ID {game.id} · 热度 {game.hotRank ?? "—"}
                      </span>
                    </button>
                  </TableCell>
                  <TableCell>{game.downloadCount} 个</TableCell>
                  <TableCell>
                    <PriceEditor game={game} onSaved={load} notify={notify} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      status={
                        game.scrapeStatus === "violation"
                          ? "violation"
                          : game.scrapeStatus === "missing"
                          ? "missing"
                          : game.lastChangeType === "updated"
                          ? "updated"
                          : game.scrapeStatus
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={game.xianyuStatus} />
                    {game.xianyuItemId ? (
                      <p className="font-data mt-1 text-[10px] text-muted-foreground">
                        {game.xianyuItemId}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>{formatDate(game.lastScrapedAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDetailId(game.id)}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        详情
                      </Button>
                      <Button
                        variant={
                          game.scrapeStatus === "violation"
                            ? "outline"
                            : "destructive"
                        }
                        size="sm"
                        disabled={updatingViolationGameId === game.id}
                        title={
                          game.scrapeStatus === "violation"
                            ? "手动恢复为采集成功"
                            : "标记为闲鱼违规并排除后续发布"
                        }
                        onClick={() => updateViolationStatus(game)}
                      >
                        {game.scrapeStatus === "violation" ? (
                          <RotateCcw className="h-3.5 w-3.5" />
                        ) : (
                          <ShieldAlert className="h-3.5 w-3.5" />
                        )}
                        {game.scrapeStatus === "violation"
                          ? "恢复成功"
                          : "标记违规"}
                      </Button>
                      <Button
                        size="sm"
                        disabled={
                          game.scrapeStatus !== "success" ||
                          syncingGameId === game.id ||
                          !selectedAccountId
                        }
                        title={
                          !selectedAccountId
                            ? "请先选择发布状态账号"
                            : game.scrapeStatus === "success"
                            ? "同步此游戏"
                            : "仅采集成功的游戏可以同步"
                        }
                        onClick={() => syncGame(game.id)}
                      >
                        {syncingGameId === game.id ? (
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        同步
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!data.items.length ? (
            <div className="p-6">
              <EmptyState
                title="没有匹配的游戏"
                description="调整关键词或筛选条件后重试。"
              />
            </div>
          ) : null}
        </CardContent>
      </Card>
      <div className="mt-4 flex items-center justify-between">
        <p className="font-data text-xs text-muted-foreground">
          第 {data.page ?? page} / {data.pageCount ?? 1} 页
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((current) => current - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= data.pageCount}
            onClick={() => setPage((current) => current + 1)}
          >
            下一页
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <GameDetail
        gameId={detailId}
        accountId={selectedAccountId}
        open={Boolean(detailId)}
        notify={notify}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      />
    </>
  );
}

function ApiKeysPage({ notify }) {
  const [xianyu, setXianyu] = useState(null);
  const [downloadKeys, setDownloadKeys] = useState([]);
  const [editingXianyu, setEditingXianyu] = useState(false);
  const [xianyuValue, setXianyuValue] = useState("");
  const [newKeyName, setNewKeyName] = useState("");
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    const payload = await api("/api/admin/api-keys");
    setXianyu(payload.xianyu ?? null);
    setDownloadKeys(payload.downloadKeys ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function copy(value) {
    await navigator.clipboard.writeText(value);
    notify("API Key 已复制");
  }

  async function saveXianyuKey() {
    setSaving(true);
    try {
      const payload = await api("/api/admin/api-keys/xianyu", {
        method: "PUT",
        body: jsonBody({ api_key: xianyuValue }),
      });
      setXianyu((current) => ({
        ...current,
        configured: true,
        maskedValue: payload.maskedValue,
      }));
      setXianyuValue("");
      setEditingXianyu(false);
      notify("闲鱼 API Key 已保存并验证");
      await load();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    } finally {
      setSaving(false);
    }
  }

  async function addDownloadKey() {
    setSaving(true);
    try {
      await api("/api/admin/api-keys/download", {
        method: "POST",
        body: jsonBody({ name: newKeyName }),
      });
      setNewKeyName("");
      notify("Gamer520 API Key 已生成");
      await load();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    } finally {
      setSaving(false);
    }
  }

  async function deleteDownloadKey(id) {
    try {
      await api(
        `/api/admin/api-keys/download/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      notify("Gamer520 API Key 已删除");
      await load();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="Credentials"
        title="API Key 管理"
        description="闲鱼 Key 保存后脱敏展示；Gamer520 下载接口 Key 可新增、删除并按要求明文展示。"
        actions={
          <Button variant="outline" onClick={load}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-primary">
              <KeyRound className="h-5 w-5" />
            </span>
            <Badge tone={xianyu?.configured ? "success" : "warning"}>
              {xianyu?.configured ? "已配置" : "未配置"}
            </Badge>
          </div>
          <CardTitle className="pt-3">闲鱼服务 API Key</CardTitle>
          <CardDescription>
            用于账号读取、素材同步和商品发布；提交时会在线验证。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {editingXianyu ? (
            <div className="space-y-3">
              <Input
                type="password"
                autoComplete="off"
                placeholder="输入新的闲鱼 API Key"
                value={xianyuValue}
                onChange={(event) => setXianyuValue(event.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={saving || !xianyuValue.trim()}
                  onClick={saveXianyuKey}
                >
                  <Save className="h-4 w-4" />
                  {saving ? "验证并保存中" : "验证并保存"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingXianyu(false);
                    setXianyuValue("");
                  }}
                >
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-lg border bg-slate-950 p-4 text-slate-100">
                <code className="font-data block break-all text-xs leading-6">
                  {xianyu?.maskedValue || "未配置"}
                </code>
              </div>
              <Button
                className="mt-3"
                variant="outline"
                size="sm"
                onClick={() => setEditingXianyu(true)}
              >
                <RefreshCw className="h-4 w-4" />
                {xianyu?.configured ? "更换 Key" : "配置 Key"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Gamer520 API Key</CardTitle>
          <CardDescription>
            用于调用 /api/download-sources；每个 Key 独立生效并明文展示。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              placeholder="新 Key 名称，例如：闲鱼自动发货"
              value={newKeyName}
              onChange={(event) => setNewKeyName(event.target.value)}
            />
            <Button
              disabled={saving || !newKeyName.trim()}
              onClick={addDownloadKey}
            >
              <Plus className="h-4 w-4" />
              新增 Key
            </Button>
          </div>
          <div className="mt-5 space-y-3">
            {downloadKeys.map((item) => (
              <div
                key={item.id}
                className="rounded-lg border bg-white p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{item.name}</p>
                    <p className="font-data mt-1 text-[10px] text-muted-foreground">
                      创建于 {formatDate(item.createdAt)}
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => deleteDownloadKey(item.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                    删除
                  </Button>
                </div>
                <div className="mt-3 rounded-lg bg-slate-950 p-4 text-slate-100">
                  <code className="font-data block break-all text-xs leading-6">
                    {item.value}
                  </code>
                </div>
                <Button
                  className="mt-3"
                  variant="outline"
                  size="sm"
                  onClick={() => copy(item.value)}
                >
                  <Copy className="h-4 w-4" />
                  复制
                </Button>
              </div>
            ))}
            {!downloadKeys.length ? (
              <EmptyState
                title="还没有 Gamer520 API Key"
                description="输入用途名称后生成第一个 Key。"
              />
            ) : null}
          </div>
        </CardContent>
      </Card>
      <Card className="mt-5 border-amber-200 bg-amber-50/60">
        <CardContent className="flex gap-3 p-5 text-sm text-amber-900">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
          <p>
            下载源接口继续使用独立的 <span className="font-data">X-API-Key</span>
            请求头；后台登录 Cookie 不能替代对外接口 Key。
          </p>
        </CardContent>
      </Card>
    </>
  );
}

function AdminShell({ onLogout }) {
  const initialRoute = window.location.hash.slice(1);
  const [route, setRoute] = useState(
    routeTitles[initialRoute] ? initialRoute : "dashboard",
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState(null);

  function notify(message, type = "success") {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 3200);
  }

  function changeRoute(nextRoute) {
    setRoute(nextRoute);
    window.history.replaceState(null, "", `#${nextRoute}`);
  }

  const pages = {
    dashboard: <DashboardPage notify={notify} />,
    tasks: <TasksPage notify={notify} />,
    products: <ProductConfigPage notify={notify} />,
    games: <GamesPage notify={notify} />,
    keys: <ApiKeysPage notify={notify} />,
  };

  return (
    <div className="min-h-screen">
      <Sidebar
        route={route}
        onRoute={changeRoute}
        onLogout={onLogout}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="w-full min-w-0 lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-background/95 px-4 backdrop-blur md:px-8">
          <div className="flex items-center gap-3">
            <Button
              className="lg:hidden"
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div>
              <p className="text-sm font-semibold">{routeTitles[route]}</p>
              <p className="font-data text-[10px] uppercase tracking-wide text-muted-foreground">
                Gamer520 / {route}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            服务在线
          </div>
        </header>
        <main className="mx-auto w-full min-w-0 max-w-[1600px] overflow-x-hidden p-4 md:p-8">
          {pages[route]}
        </main>
      </div>
      {toast ? (
        <div
          className={cn(
            "fixed bottom-5 right-5 z-[60] flex max-w-sm items-center gap-3 rounded-lg border bg-white px-4 py-3 text-sm shadow-xl",
            toast.type === "error" ? "border-rose-200" : "border-emerald-200",
          )}
        >
          {toast.type === "error" ? (
            <X className="h-4 w-4 text-rose-600" />
          ) : (
            <Check className="h-4 w-4 text-emerald-600" />
          )}
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadSession = useCallback(async () => {
    try {
      const next = await api("/api/auth/session");
      setSession(next);
      return next;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  async function logout() {
    await api("/api/auth/logout", {
      method: "POST",
      body: jsonBody({}),
    });
    setSession({ authenticated: false });
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <LoaderCircle className="h-6 w-6 animate-spin text-primary" />
      </main>
    );
  }
  if (!session?.authenticated) {
    return <LoginPage onLoggedIn={loadSession} />;
  }
  return <AdminShell onLogout={logout} />;
}
