import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Settings as SettingsIcon, Brain, MessageSquare, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Settings() {
  const { data: tweaks, isLoading: tweaksLoading, refetch: refetchTweaks } = trpc.ai.tweaks.useQuery();
  const { data: recentMsgs, isLoading: msgsLoading } = trpc.ai.recentMessages.useQuery();
  const addTweak = trpc.ai.addTweak.useMutation({
    onSuccess: () => { toast.success("AI behavior updated"); setComment(""); refetchTweaks(); },
    onError: (e) => toast.error(e.message),
  });
  const syncMutation = trpc.ghl.syncContacts.useMutation({
    onSuccess: (data) => toast.success(`Synced ${data.contacts} contacts`),
    onError: () => toast.error("Sync failed"),
  });

  const [comment, setComment] = useState("");

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <SettingsIcon className="h-6 w-6" /> Settings
          </h1>
          <p className="text-muted-foreground mt-1">Configure the AI brain and system integrations</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* AI Tweaker */}
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Brain className="h-4 w-4" /> Communication AI Tweaker
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Review recent AI messages below. If you see something you want to change, add a comment and the AI will adjust its behavior going forward.
                </p>
                <Textarea
                  placeholder='e.g., "Tone down the urgency on follow-ups" or "Stop mentioning same-day pickup so much"'
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={3}
                />
                <Button
                  onClick={() => addTweak.mutate({ instruction: comment })}
                  disabled={!comment.trim() || addTweak.isPending}
                  className="w-full"
                >
                  {addTweak.isPending ? "Applying..." : "Apply Feedback to AI"}
                </Button>
              </CardContent>
            </Card>

            {/* Active Tweaks */}
            <Card>
              <CardHeader><CardTitle className="text-base">Active AI Adjustments</CardTitle></CardHeader>
              <CardContent>
                {tweaksLoading ? (
                  <div className="space-y-2">{[1,2].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
                ) : tweaks && tweaks.length > 0 ? (
                  <div className="space-y-2">
                    {tweaks.map((t) => (
                      <div key={t.id} className="p-3 rounded-lg border bg-muted/30 text-sm">
                        <p>{t.tweakInstruction}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Added {t.appliedAt ? new Date(t.appliedAt).toLocaleDateString() : ""}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">No adjustments yet. The AI is running with default behavior.</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Recent AI Messages for Review */}
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" /> Recent AI Messages
                </CardTitle>
              </CardHeader>
              <CardContent>
                {msgsLoading ? (
                  <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
                ) : recentMsgs && recentMsgs.length > 0 ? (
                  <div className="space-y-3 max-h-[500px] overflow-y-auto">
                    {recentMsgs.map((msg) => (
                      <div key={msg.id} className="p-3 rounded-lg border bg-primary/5">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium">{msg.senderName || "AI"}</span>
                          <Badge variant="outline" className="text-xs">{msg.channel || "SMS"}</Badge>
                        </div>
                        <p className="text-sm">{msg.messageBody}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {msg.timestamp ? new Date(msg.timestamp).toLocaleString() : ""}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">No AI messages to review yet.</p>
                )}
              </CardContent>
            </Card>

            {/* GHL Sync */}
            <Card>
              <CardHeader><CardTitle className="text-base">GHL Sync</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">Manually trigger a sync of contacts from GoHighLevel.</p>
                <Button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending} variant="outline" className="w-full">
                  <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? "animate-spin" : ""}`} />
                  {syncMutation.isPending ? "Syncing..." : "Sync Contacts from GHL"}
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
