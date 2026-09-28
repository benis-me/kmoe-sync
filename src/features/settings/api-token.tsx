// API 与 MCP: create / rotate / revoke the API token (shown once) and ready-to-paste REST and MCP snippets.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-react';
import { request } from '@/lib/api';
import { settingsQuery } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Card, CardFooter } from '@/components/ui/card';
import { ConfirmAction, ErrorState } from '@/components/app/feedback';
import { CopyButton } from '@/components/app/fields';
import { SectionSkeleton } from './common';

function Snippet({ title, code, note }: { title: string; code: string; note?: string }) {
  return <div className="flex flex-col gap-2">
    <span className="text-sm font-medium">{title}</span>
    <div className="flex items-start gap-2 rounded-xl bg-muted/60 py-2 pr-2 pl-3.5 ring-1 ring-border">
      <pre className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{code}</pre>
      <CopyButton text={code} label={`复制${title}命令`} />
    </div>
    {note && <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>}
  </div>;
}

export function ApiSection() {
  const client = useQueryClient();
  const settings = useQuery(settingsQuery);
  const [token, setToken] = useState<string | null>(null);
  const setHas = (apiToken: boolean) => client.setQueryData(settingsQuery.queryKey, old => old && { ...old, apiToken });
  const create = useMutation({
    mutationFn: () => request('POST /api/token'),
    onSuccess: ({ token: next }) => {
      toast.success(settings.data?.apiToken ? '令牌已轮换，旧令牌已失效' : '令牌已生成');
      setToken(next);
      setHas(true);
    },
  });
  const revoke = useMutation({
    mutationFn: () => request('DELETE /api/token'),
    onSuccess: () => { setToken(null); setHas(false); toast.success('令牌已撤销'); },
  });
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  if (!settings.data) return <SectionSkeleton />;
  const has = settings.data.apiToken;
  const shown = token ?? '<令牌>';
  const origin = location.origin;

  return <>
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-4 p-5 sm:p-6">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"><KeyRound className="size-4" /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-[15px] font-semibold tracking-tight">API 令牌</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {has ? '已生成。令牌只保存摘要，无法再次查看；丢失了就轮换一个新的。' : '还没有令牌。生成后，脚本和 AI 助手就能查询书架、订阅和下载漫画。'}
          </p>
        </div>
      </div>
      {token && <div className="mx-5 mb-5 flex animate-rise flex-col gap-2.5 rounded-xl border border-warning/30 bg-warning-soft p-3.5 sm:mx-6 sm:mb-6">
        <p className="flex items-center gap-2 text-xs font-medium text-warning"><TriangleAlert className="size-3.5 shrink-0" />只显示这一次，请现在复制保存。</p>
        <div className="flex items-center gap-2 rounded-lg bg-card py-1 pr-1 pl-3 ring-1 ring-border">
          <code className="min-w-0 flex-1 truncate font-mono text-[13px]" aria-label="新的 API 令牌">{token}</code>
          <CopyButton text={token} label="复制令牌" />
        </div>
      </div>}
      <CardFooter className="flex-wrap gap-2 px-5 py-3.5 sm:px-6">
        {has ? <>
          <ConfirmAction title="撤销 API 令牌？" description="使用这个令牌的脚本和 MCP 客户端会立即失去访问权限。" action="撤销" onConfirm={() => revoke.mutate()}>
            <Button variant="ghost" size="sm" className="-ml-2 text-destructive hover:bg-destructive/10 hover:text-destructive">撤销</Button>
          </ConfirmAction>
          <ConfirmAction title="轮换 API 令牌？" description="会生成一个新令牌，旧令牌立即失效，需要在用到它的地方换成新的。" action="轮换" variant="default" onConfirm={() => create.mutate()}>
            <Button variant="outline" size="sm" className="ml-auto" aria-disabled={create.isPending}>
              {create.isPending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RotateCcw data-icon="inline-start" />}轮换令牌
            </Button>
          </ConfirmAction>
        </> : <Button size="sm" className="ml-auto" aria-disabled={create.isPending} onClick={() => { if (!create.isPending) create.mutate(); }}>
          {create.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}生成令牌
        </Button>}
      </CardFooter>
    </Card>

    <Card className="gap-5 p-5 sm:p-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold tracking-tight">使用方法</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">令牌只能操作漫画、订阅和下载；管理员密码、Kmoe 登录、存储位置和通知只能在这里修改。</p>
      </div>
      <Snippet title="REST" code={`curl -H "Authorization: Bearer ${shown}" ${origin}/api/v1/shelf`}
        note="接口与网页相同，路径把 /api/ 换成 /api/v1/，例如 /api/v1/search?q=书名、/api/v1/tasks。" />
      <Snippet title="MCP · Claude Code" code={`claude mcp add --transport http kmoesync ${origin}/mcp --header "Authorization: Bearer ${shown}"`}
        note="其他客户端（Claude Desktop、Cursor 等）在 HTTP MCP 配置里填写同样的地址和请求头。" />
    </Card>
  </>;
}
