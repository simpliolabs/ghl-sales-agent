import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Brain, MessageSquare, TrendingUp, Zap, GraduationCap, BarChart3, Target, RefreshCw } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";

export default function AIPerformance() {
  const { data: perf, isLoading } = trpc.ai.performance.useQuery();
  const { data: recentMsgs, isLoading: msgsLoading } = trpc.ai.recentMessages.useQuery();
  const { data: insights, isLoading: insightsLoading } = trpc.ai.learningInsights.useQuery();
  const { user } = useAuth();
  const backfill = trpc.ai.triggerBackfill.useMutation({
    onSuccess: (data) => toast.success(`Backfill complete: ${data.created} outcome records created`),
    onError: () => toast.error("Backfill failed"),
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Brain className="h-6 w-6" /> AI Performance
          </h1>
          <p className="text-muted-foreground mt-1">How the AI brain is performing across all leads</p>
        </div>

        {/* --- KPI Cards --- */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading ? (
            [1,2,3,4].map(i => <Skeleton key={i} className="h-24 w-full rounded-lg" />)
          ) : (
            <>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-2xl font-bold">{perf?.aiMessages || 0}</p>
                      <p className="text-xs text-muted-foreground mt-1">AI Messages Sent</p>
                    </div>
                    <div className="h-10 w-10 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 flex items-center justify-center">
                      <MessageSquare className="h-4 w-4 text-emerald-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-2xl font-bold">{perf?.avgScore || 0}</p>
                      <p className="text-xs text-muted-foreground mt-1">Avg Opportunity Score</p>
                    </div>
                    <div className="h-10 w-10 rounded-lg bg-blue-50 dark:bg-blue-950/30 flex items-center justify-center">
                      <TrendingUp className="h-4 w-4 text-blue-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-2xl font-bold">{perf?.hotLeads || 0}</p>
                      <p className="text-xs text-muted-foreground mt-1">Hot Leads Generated</p>
                    </div>
                    <div className="h-10 w-10 rounded-lg bg-orange-50 dark:bg-orange-950/30 flex items-center justify-center">
                      <Zap className="h-4 w-4 text-orange-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-2xl font-bold">{perf?.totalLeads || 0}</p>
                      <p className="text-xs text-muted-foreground mt-1">Total Leads Managed</p>
                    </div>
                    <div className="h-10 w-10 rounded-lg bg-violet-50 dark:bg-violet-950/30 flex items-center justify-center">
                      <Brain className="h-4 w-4 text-violet-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>

        {/* --- Self-Learning Insights --- */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <GraduationCap className="h-4 w-4" /> Self-Learning Insights
                </CardTitle>
                <CardDescription>
                  {insights?.totalTracked
                    ? `Tracking ${insights.totalTracked} message outcomes — ${insights.overallReplyRate}% reply rate, ${insights.overallConversionRate}% conversion`
                    : "The AI learns which frameworks and channels convert best"}
                </CardDescription>
              </div>
              {user?.role === "admin" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => backfill.mutate()}
                  disabled={backfill.isPending}
                >
                  <RefreshCw className={`h-3 w-3 mr-1 ${backfill.isPending ? "animate-spin" : ""}`} />
                  Backfill
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {insightsLoading ? (
              <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-12 w-full" />)}</div>
            ) : !insights || insights.totalTracked === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No outcome data yet. The system will start tracking as AI messages are sent and leads reply.
                {user?.role === "admin" && " Click 'Backfill' to retroactively scan existing conversations."}
              </p>
            ) : (
              <div className="space-y-6">
                {/* Framework Performance */}
                {insights.frameworkStats.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
                      <BarChart3 className="h-3.5 w-3.5" /> Framework Performance
                    </h3>
                    <div className="space-y-2">
                      {insights.frameworkStats.map((fw) => (
                        <div key={fw.framework} className="flex items-center gap-3 p-2.5 rounded-lg border bg-muted/20">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{fw.framework}</span>
                              <Badge variant="outline" className="text-[10px]">{fw.totalSent} sent</Badge>
                            </div>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                            <div className="text-right">
                              <span className={`font-semibold text-sm ${fw.replyRate >= 30 ? "text-emerald-600" : fw.replyRate >= 15 ? "text-amber-600" : "text-muted-foreground"}`}>
                                {fw.replyRate}%
                              </span>
                              <span className="ml-1">reply</span>
                            </div>
                            <div className="text-right">
                              <span className="font-semibold text-sm">{fw.positiveRate}%</span>
                              <span className="ml-1">positive</span>
                            </div>
                            {fw.conversions > 0 && (
                              <div className="text-right">
                                <span className="font-semibold text-sm text-emerald-600">{fw.conversions}</span>
                                <span className="ml-1">conv</span>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Channel Performance */}
                {insights.channelStats.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
                      <MessageSquare className="h-3.5 w-3.5" /> Channel Performance
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                      {insights.channelStats.map((ch) => (
                        <div key={ch.channel} className="p-3 rounded-lg border bg-muted/20">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium">{ch.channel}</span>
                            <Badge variant="outline" className="text-[10px]">{ch.totalSent} sent</Badge>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <span><span className={`font-semibold ${ch.replyRate >= 30 ? "text-emerald-600" : "text-muted-foreground"}`}>{ch.replyRate}%</span> reply</span>
                            {ch.avgReplyMinutes > 0 && <span>{ch.avgReplyMinutes}min avg</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Top Performing Combos */}
                {insights.topPerformers.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
                      <Target className="h-3.5 w-3.5" /> Top Performing Combos
                    </h3>
                    <div className="space-y-1.5">
                      {insights.topPerformers.map((tp, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm">
                          <span className="text-muted-foreground w-5 text-right shrink-0">#{i + 1}</span>
                          <Badge variant="secondary" className="text-[10px]">{tp.framework}</Badge>
                          <span className="text-muted-foreground">×</span>
                          <span className="truncate">{tp.segment}</span>
                          <span className="ml-auto shrink-0 font-semibold text-emerald-600">{tp.replyRate}%</span>
                          <span className="text-xs text-muted-foreground shrink-0">(n={tp.sampleSize})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* --- Recent AI Messages --- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent AI Messages</CardTitle>
          </CardHeader>
          <CardContent>
            {msgsLoading ? (
              <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
            ) : recentMsgs && recentMsgs.length > 0 ? (
              <div className="space-y-3">
                {recentMsgs.map((msg) => (
                  <div key={msg.id} className="p-3 rounded-lg border bg-muted/30">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium">{msg.senderName || "AI"} → Lead #{msg.leadId}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">{msg.channel || "SMS"}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {msg.timestamp ? new Date(msg.timestamp).toLocaleString() : ""}
                        </span>
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-2">{msg.messageBody}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">No AI messages yet. The brain will start sending messages as leads come in.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
