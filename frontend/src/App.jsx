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
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  TimerReset,
  Truck,
  UserRound,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";

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
  failed: "失败",
  partial: "部分完成",
  interrupted: "已中断",
  unknown: "待确认",
  none: "无",
  material: "加入素材库",
  material_update: "更新素材库",
  published: "发布成功",
  updated: "已更新",
};

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
        ? `${progress.materialCompleted ?? 0}/${progress.materialTotal ?? 0}`
        : `${dashboard?.totals?.materialSynced ?? 0} 已同步`,
      active: progress?.phase === "material",
    },
    {
      icon: Truck,
      label: "发布",
      detail: progress
        ? `${progress.publishCompleted ?? 0}/${progress.publishTotal ?? 0}`
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
              当前账号：{dashboard?.xianyu?.accountId ?? "未配置"}
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
          label="游戏数据"
          value={data?.totals?.games}
          note={`${formatNumber(data?.totals?.eligibleGames)} 条具备下载资源`}
        />
        <StatCard
          icon={Database}
          label="素材库"
          value={data?.totals?.materialSynced}
          note="同名或已有素材自动跳过"
          tone="slate"
        />
        <StatCard
          icon={PackageCheck}
          label="发布成功"
          value={data?.totals?.publishedGames}
          note="商品编号已回写 Gamer520"
          tone="green"
        />
        <StatCard
          icon={TimerReset}
          label="需要关注"
          value={data?.totals?.publishAttention}
          note="失败会跳过，未知结果需确认"
          tone="amber"
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
                  <StatusBadge status="running" />
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span>导入素材库</span>
                    <span className="font-data">
                      {data.scheduler.sync.progress.materialCompleted ?? 0} /{" "}
                      {data.scheduler.sync.progress.materialTotal ?? 0}
                    </span>
                  </div>
                  <Progress
                    value={data.scheduler.sync.progress.materialCompleted}
                    max={data.scheduler.sync.progress.materialTotal}
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
                  <Progress
                    value={data.scheduler.sync.progress.publishCompleted}
                    max={data.scheduler.sync.progress.publishTotal}
                    label="发布商品进度"
                  />
                </div>
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
    </>
  );
}

function TaskProgress({ schedule }) {
  const progress = schedule?.sync?.progress;
  if (!progress) return null;
  return (
    <Card className="border-blue-200 bg-blue-50/40">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>同步任务 #{progress.runId}</CardTitle>
          <StatusBadge status="running" />
        </div>
        <CardDescription>{progress.currentTitle ?? "正在准备"}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 md:grid-cols-2">
        <div className="space-y-2">
          <div className="flex justify-between text-xs font-medium">
            <span>导入素材库</span>
            <span className="font-data">
              {progress.materialCompleted ?? 0}/{progress.materialTotal ?? 0}
            </span>
          </div>
          <Progress
            value={progress.materialCompleted}
            max={progress.materialTotal}
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
          <Progress
            value={progress.publishCompleted}
            max={progress.publishTotal}
            label="发布商品进度"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function TasksPage({ notify }) {
  const [schedule, setSchedule] = useState(null);
  const [runs, setRuns] = useState([]);
  const [logs, setLogs] = useState([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [nextSchedule, nextRuns, nextLogs] = await Promise.all([
      api("/api/settings/schedule"),
      api("/api/runs?limit=50"),
      api("/api/logs?limit=80"),
    ]);
    setSchedule(nextSchedule);
    setRuns(nextRuns);
    setLogs(nextLogs);
  }, []);
  usePolling(load);

  function updateSchedule(path, value) {
    setSchedule((current) => {
      const next = structuredClone(current);
      if (path.length === 1) next[path[0]] = value;
      else next[path[0]][path[1]] = value;
      return next;
    });
  }

  async function saveSchedule() {
    setSaving(true);
    try {
      await api("/api/settings/schedule", {
        method: "PUT",
        body: jsonBody({
          cron_timezone: schedule.cronTimezone,
          crawl: {
            enabled: schedule.crawl.enabled,
            cron_schedule: schedule.crawl.cronSchedule,
          },
          sync: {
            enabled: schedule.sync.enabled,
            cron_schedule: schedule.sync.cronSchedule,
            mode: schedule.sync.mode,
          },
        }),
      });
      notify("定时任务配置已保存");
      await load();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    } finally {
      setSaving(false);
    }
  }

  async function runTask(kind, mode) {
    try {
      await api(kind === "crawl" ? "/api/crawl/run" : "/api/sync/run", {
        method: "POST",
        body: jsonBody(kind === "sync" ? { mode } : {}),
      });
      notify(kind === "crawl" ? "采集任务已启动" : "同步任务已启动");
      await load();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    }
  }

  async function control(kind, action) {
    try {
      await api(`/api/tasks/${kind}/${action}`, {
        method: "POST",
        body: jsonBody({}),
      });
      notify(action === "interrupt" ? "任务将在安全点中断" : "任务已恢复");
      await load();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    }
  }

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
            <Button onClick={() => runTask("sync", "pending")}>
              <Play className="h-4 w-4" />
              同步未发布
            </Button>
          </>
        }
      />
      <TaskProgress schedule={schedule} />
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
            {[
              ["crawl", "采集任务"],
              ["sync", "闲鱼同步"],
            ].map(([kind, label]) => (
              <div key={kind} className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">{label}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      下次执行 {formatDate(schedule?.[kind]?.nextRun)}
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(schedule?.[kind]?.enabled)}
                      onChange={(event) =>
                        updateSchedule([kind, "enabled"], event.target.checked)
                      }
                    />
                    启用
                  </label>
                </div>
                <Input
                  className="font-data"
                  value={schedule?.[kind]?.cronSchedule ?? ""}
                  onChange={(event) =>
                    updateSchedule([kind, "cronSchedule"], event.target.value)
                  }
                />
                {kind === "sync" ? (
                  <Select
                    value={schedule?.sync?.mode ?? "pending"}
                    onChange={(event) =>
                      updateSchedule(["sync", "mode"], event.target.value)
                    }
                  >
                    <option value="pending">未发布商品</option>
                    <option value="all">全部待处理商品</option>
                    <option value="updated">已更新商品</option>
                  </Select>
                ) : null}
              </div>
            ))}
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
              发布失败会记录后跳过，结果未知时停止避免重复。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Button variant="outline" onClick={() => runTask("sync", "all")}>
                全部商品
              </Button>
              <Button
                variant="outline"
                onClick={() => runTask("sync", "pending")}
              >
                未发布商品
              </Button>
              <Button
                variant="outline"
                onClick={() => runTask("sync", "updated")}
              >
                已更新商品
              </Button>
            </div>
            <Separator />
            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                variant="secondary"
                onClick={() =>
                  control(
                    schedule?.sync?.active ? "sync" : "crawl",
                    "interrupt",
                  )
                }
                disabled={!schedule?.crawl?.active && !schedule?.sync?.active}
              >
                <Pause className="h-4 w-4" />
                中断当前任务
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
                  !schedule?.crawl?.interrupted &&
                  !schedule?.sync?.interrupted
                }
              >
                <RotateCcw className="h-4 w-4" />
                恢复任务
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
    </>
  );
}

function ProductConfigPage({ notify }) {
  const [settings, setSettings] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  const load = useCallback(async () => {
    setSettings(await api("/api/settings/xianyu"));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function loadAccounts() {
    setLoadingAccounts(true);
    try {
      const payload = await api("/api/xianyu/accounts");
      setAccounts(payload.items ?? []);
      notify("发布账号列表已刷新");
    } catch (caught) {
      notify(errorMessage(caught), "error");
    } finally {
      setLoadingAccounts(false);
    }
  }

  function update(key, value) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    try {
      await api("/api/settings/xianyu", {
        method: "PUT",
        body: jsonBody({
          account_id: settings.accountId,
          default_price: Number(settings.defaultPrice),
          title_template: settings.titleTemplate,
          description_template: settings.descriptionTemplate,
          image_template: settings.imageTemplate,
        }),
      });
      notify("商品配置已保存");
      await load();
    } catch (caught) {
      notify(errorMessage(caught), "error");
    }
  }

  const preview = useMemo(() => {
    if (!settings) return null;
    const values = {
      title: "赛博朋克 2077 终极版",
      id: "4121",
      description: "夜之城开放世界动作角色扮演游戏。",
      cloud_drives: "百度 / 夸克",
      price: settings.defaultPrice ?? 1,
      image_url: "https://www.gamer520.com/sample.jpg",
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

  return (
    <>
      <PageHeading
        eyebrow="Listing rules"
        title="商品配置"
        description="配置发布账号、默认价格和素材模板。已有商品编号或已有素材的游戏会跳过。"
        actions={
          <>
            <Button variant="outline" onClick={loadAccounts}>
              <RefreshCw
                className={cn("h-4 w-4", loadingAccounts && "animate-spin")}
              />
              刷新账号
            </Button>
            <Button onClick={save}>
              <Save className="h-4 w-4" />
              保存配置
            </Button>
          </>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>发布设置</CardTitle>
            <CardDescription>占位符会在同步素材时替换。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>发布账号 account_id</Label>
                <Select
                  value={settings?.accountId ?? ""}
                  onChange={(event) => update("accountId", event.target.value)}
                >
                  <option value="">请选择发布账号</option>
                  {accounts.map((account) => (
                    <option
                      key={account.accountId}
                      value={account.accountId}
                      disabled={!account.enabled}
                    >
                      {account.remark || account.accountId} · {account.accountId}
                    </option>
                  ))}
                  {settings?.accountId &&
                  !accounts.some(
                    (account) => account.accountId === settings.accountId,
                  ) ? (
                    <option value={settings.accountId}>{settings.accountId}</option>
                  ) : null}
                </Select>
              </div>
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
            </div>
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
                {preview?.image ? (
                  <img
                    className="h-full w-full object-cover"
                    src={preview.image}
                    alt=""
                  />
                ) : null}
              </div>
              <div className="p-5">
                <Badge tone="success">¥ {settings?.defaultPrice ?? 1}</Badge>
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

function GameDetail({ gameId, open, onOpenChange }) {
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (!open || !gameId) return;
    void api(`/api/games/${gameId}`).then(setDetail);
  }, [gameId, open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{detail?.game?.title ?? `游戏 ${gameId}`}</DialogTitle>
          <DialogDescription>
            游戏凭证、下载源与资源详情页
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
        {detail?.game?.detailPageUrl ? (
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
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, pageCount: 1 });
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(async () => {
    const parameters = new URLSearchParams({
      page: String(page),
      pageSize: "20",
      query,
      status,
      xianyuStatus,
    });
    setData(await api(`/api/games?${parameters}`));
  }, [page, query, status, xianyuStatus]);
  useEffect(() => {
    void load();
  }, [load]);

  async function syncGame(gameId) {
    try {
      await api(`/api/games/${gameId}/sync`, {
        method: "POST",
        body: jsonBody({}),
      });
      notify(`游戏 ${gameId} 同步已启动`);
    } catch (caught) {
      notify(errorMessage(caught), "error");
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
          <div className="grid gap-3 lg:grid-cols-[1fr_180px_180px]">
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
              <option value="none">无</option>
              <option value="material">加入素材库</option>
              <option value="publishing">发布中</option>
              <option value="published">发布成功</option>
              <option value="material_update">更新素材库</option>
            </Select>
          </div>
        </CardContent>
      </Card>
      <Card className="mt-5">
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>游戏列表</CardTitle>
            <CardDescription className="mt-1">
              共 {formatNumber(data.total)} 条
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
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
                        game.lastChangeType === "updated"
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
                      <Button size="sm" onClick={() => syncGame(game.id)}>
                        <RefreshCw className="h-3.5 w-3.5" />
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
        open={Boolean(detailId)}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      />
    </>
  );
}

function ApiKeysPage({ notify }) {
  const [keys, setKeys] = useState([]);
  const load = useCallback(async () => {
    const payload = await api("/api/admin/api-keys");
    setKeys(payload.items ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function copy(value) {
    await navigator.clipboard.writeText(value);
    notify("API Key 已复制");
  }

  return (
    <>
      <PageHeading
        eyebrow="Credentials"
        title="API Key 管理"
        description="仅管理员登录会话可以查看。Key 按要求明文展示，请勿通过聊天或截图传播。"
        actions={
          <Button variant="outline" onClick={load}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
        }
      />
      <div className="grid gap-5 xl:grid-cols-2">
        {keys.map((item) => (
          <Card key={item.id}>
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-primary">
                  <KeyRound className="h-5 w-5" />
                </span>
                <Badge tone={item.configured ? "success" : "warning"}>
                  {item.configured ? "已配置" : "未配置"}
                </Badge>
              </div>
              <CardTitle className="pt-3">{item.name}</CardTitle>
              <CardDescription>{item.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border bg-slate-950 p-4 text-slate-100">
                <code className="font-data block break-all text-xs leading-6">
                  {item.value || "未配置"}
                </code>
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!item.value}
                  onClick={() => copy(item.value)}
                >
                  <Copy className="h-4 w-4" />
                  复制
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
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
