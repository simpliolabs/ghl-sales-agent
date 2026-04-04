import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Brain, MessageSquare, TrendingUp, Zap } from "lucide-react";

export default function AIPerformance() {
  const { data: perf, isLoading } = trpc.ai.performance.useQuery();
  const { data: recentMsgs, isLoading: msgsLoading } = trpc.ai.recentMessages.useQuery();

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Brain className="h-6 w-6" /> AI Performance
          </h1>
          <p className="text-muted-foreground mt-1">How the AI brain is performing across all leads</p>
        </div>

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
                    <div className="h-10 w-10 rounded-lg bg-emerald-50 flex items-center justify-center">
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
                    <div className="h-10 w-10 rounded-lg bg-blue-50 flex items-center justify-center">
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
                    <div className="h-10 w-10 rounded-lg bg-orange-50 flex items-center justify-center">
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
                    <div className="h-10 w-10 rounded-lg bg-violet-50 flex items-center justify-center">
                      <Brain className="h-4 w-4 text-violet-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>

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
