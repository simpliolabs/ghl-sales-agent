import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Settings as SettingsIcon, Brain, MessageSquare, RefreshCw, Webhook, Copy, Shield, UserPlus, Users, Trash2, Link } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  const [inviteRole, setInviteRole] = useState<"admin" | "viewer">("viewer");

  // Invite management
  const { data: invitesList, refetch: refetchInvites } = trpc.invites.list.useQuery();
  const createInvite = trpc.invites.create.useMutation({
    onSuccess: () => { toast.success("Invite link created"); refetchInvites(); },
    onError: (e) => toast.error(e.message),
  });
  const deleteInvite = trpc.invites.delete.useMutation({
    onSuccess: () => { toast.success("Invite revoked"); refetchInvites(); },
    onError: (e) => toast.error(e.message),
  });

  // User management
  const { data: usersList, refetch: refetchUsers } = trpc.users.list.useQuery();
  const updateRole = trpc.users.updateRole.useMutation({
    onSuccess: () => { toast.success("Role updated"); refetchUsers(); },
    onError: (e) => toast.error(e.message),
  });
  const purgeGhosts = trpc.users.purgeGhosts.useMutation({
    onSuccess: (data) => { toast.success(`Purged ${data.removed} ghost account${data.removed === 1 ? '' : 's'}`); refetchUsers(); },
    onError: (e) => toast.error(e.message),
  });

  // Foundation verification
  const [verifyA5Result, setVerifyA5Result] = useState<string | null>(null);
  const [verifyC3Result, setVerifyC3Result] = useState<string | null>(null);
  const [verifyContentGuardResult, setVerifyContentGuardResult] = useState<string | null>(null);
  const verifyA5 = trpc.verifyFoundationA5.useMutation({
    onSuccess: (data: unknown) => { setVerifyA5Result(JSON.stringify(data, null, 2)); toast.success('A.5 verification complete'); },
    onError: (e: { message: string }) => { setVerifyA5Result('ERROR: ' + e.message); toast.error('A.5 verification failed'); },
  });
  const verifyC3 = trpc.verifyFoundationC3.useMutation({
    onSuccess: (data: unknown) => { setVerifyC3Result(JSON.stringify(data, null, 2)); toast.success('C.3 verification complete'); },
    onError: (e: { message: string }) => { setVerifyC3Result('ERROR: ' + e.message); toast.error('C.3 verification failed'); },
  });
  const verifyContentGuard = trpc.verifyContentGuard.useMutation({
    onSuccess: (data: unknown) => { setVerifyContentGuardResult(JSON.stringify(data, null, 2)); toast.success('Content guard verification complete'); },
    onError: (e: { message: string }) => { setVerifyContentGuardResult('ERROR: ' + e.message); toast.error('Content guard verification failed'); },
  });

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
                    {tweaks.map((t: { id: number; tweakInstruction: string; appliedAt?: Date | null }) => (
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

            {/* Foundation Verification */}
            <Card className="border-purple-200 bg-purple-50/30">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Shield className="h-4 w-4 text-purple-600" /> Foundation Verification
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">Run live integration tests against the deployed runtime. Results appear below each button.</p>
                <div className="space-y-3">
                  <div>
                    <Button onClick={() => { setVerifyA5Result(null); verifyA5.mutate(); }} disabled={verifyA5.isPending} variant="outline" className="w-full border-purple-300">
                      <Shield className={`h-4 w-4 mr-2 ${verifyA5.isPending ? 'animate-spin' : ''}`} />
                      {verifyA5.isPending ? 'Running A.5...' : 'Run verifyFoundationA5'}
                    </Button>
                    {verifyA5Result && (
                      <pre className="mt-2 p-3 bg-black/90 text-green-400 text-xs rounded overflow-auto max-h-64 whitespace-pre-wrap">{verifyA5Result}</pre>
                    )}
                  </div>
                  <div>
                    <Button onClick={() => { setVerifyC3Result(null); verifyC3.mutate(); }} disabled={verifyC3.isPending} variant="outline" className="w-full border-purple-300">
                      <Shield className={`h-4 w-4 mr-2 ${verifyC3.isPending ? 'animate-spin' : ''}`} />
                      {verifyC3.isPending ? 'Running C.3 (LLM call ~15s)...' : 'Run verifyFoundationC3'}
                    </Button>
                    {verifyC3Result && (
                      <pre className="mt-2 p-3 bg-black/90 text-green-400 text-xs rounded overflow-auto max-h-64 whitespace-pre-wrap">{verifyC3Result}</pre>
                    )}
                  </div>
                  <div>
                    <Button onClick={() => { setVerifyContentGuardResult(null); verifyContentGuard.mutate(); }} disabled={verifyContentGuard.isPending} variant="outline" className="w-full border-purple-300">
                      <Shield className={`h-4 w-4 mr-2 ${verifyContentGuard.isPending ? 'animate-spin' : ''}`} />
                      {verifyContentGuard.isPending ? 'Running Patch 1 content guard...' : 'Run verifyContentGuard (Patch 1)'}
                    </Button>
                    {verifyContentGuardResult && (
                      <pre className="mt-2 p-3 bg-black/90 text-green-400 text-xs rounded overflow-auto max-h-64 whitespace-pre-wrap">{verifyContentGuardResult}</pre>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Webhook Setup Instructions */}
            <Card className="border-blue-200 bg-blue-50/30">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Webhook className="h-4 w-4" /> Webhook Setup
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Connect GHL to this system using <strong>Workflows</strong>. All events use a single unified webhook URL.
                </p>
                <div className="rounded-lg border bg-white p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Unified Webhook URL (use for all workflows)</p>
                  <div className="flex items-center gap-2">
                    <code className="text-xs bg-muted px-2 py-1 rounded flex-1 overflow-x-auto">{`${window.location.origin}/api/webhooks/ghl`}</code>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/api/webhooks/ghl`); toast.success("Copied!"); }}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
                <div className="rounded-lg border bg-white p-3">
                  <p className="text-xs font-semibold mb-2">Create these 10 Workflows in GHL:</p>
                  <div className="text-xs text-muted-foreground space-y-2">
                    <p className="text-xs font-medium text-foreground">Core (Required):</p>
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">1</Badge>
                      <div><strong>New Contact Created</strong> — Trigger: Contact Created → Webhook → POST</div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">2</Badge>
                      <div><strong>Inbound Message</strong> — Trigger: Customer Replied → Webhook → POST</div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">3</Badge>
                      <div><strong>Outbound Message</strong> — Trigger: Outbound Message → Webhook → POST <Badge variant="destructive" className="text-[9px] ml-1">CRITICAL</Badge></div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">4</Badge>
                      <div><strong>Pipeline Stage Changed</strong> — Trigger: Pipeline Stage Changed → Webhook → POST</div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">5</Badge>
                      <div><strong>Opportunity Updated</strong> — Trigger: Opportunity Changed → Webhook → POST</div>
                    </div>
                    <p className="text-xs font-medium text-foreground mt-3">Phase 2 (Recommended):</p>
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">6</Badge>
                      <div><strong>Appointment Created/Updated</strong> — Trigger: Appointment Status → Webhook → POST</div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">7</Badge>
                      <div><strong>Contact DND Changed</strong> — Trigger: Contact DND → Webhook → POST</div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">8</Badge>
                      <div><strong>Note Added</strong> — Trigger: Note Created → Webhook → POST</div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">9</Badge>
                      <div><strong>Email Events</strong> — Trigger: Email Opened/Clicked/Bounced → Webhook → POST</div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">10</Badge>
                      <div><strong>Task Completed</strong> — Trigger: Task Completed → Webhook → POST</div>
                    </div>
                  </div>
                </div>
                <div className="rounded-lg border bg-white p-3">
                  <p className="text-xs font-semibold mb-2">How to set up in GHL:</p>
                  <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                    <li>Go to <strong>Automation → Workflows</strong> in your GHL sub-account</li>
                    <li>Click <strong>"Create Workflow"</strong> → Start from scratch</li>
                    <li>Add a <strong>Trigger</strong> (e.g., Contact Created, Customer Replied, etc.)</li>
                    <li>Add an <strong>Action → Webhook</strong></li>
                    <li>Set method to <strong>POST</strong>, paste the URL above</li>
                    <li>Save and <strong>Publish</strong> the workflow</li>
                    <li>Repeat for all 10 workflows listed above</li>
                  </ol>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                  <p className="text-xs"><strong>Pipeline Automation:</strong> When stages change, the system automatically assigns tasks to the right team member (César for proofs, Cindy for production/shipping) and sends customer notifications.</p>
                </div>
              </CardContent>
            </Card>

            {/* Team & Invites */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <UserPlus className="h-4 w-4" /> Team Invites
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">Generate invite links for team members. Links expire in 7 days.</p>
                <div className="flex gap-2">
                  <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as "admin" | "viewer")}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="viewer">Viewer</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button onClick={() => createInvite.mutate({ role: inviteRole })} disabled={createInvite.isPending} className="flex-1">
                    <Link className="h-4 w-4 mr-2" />
                    {createInvite.isPending ? "Creating..." : "Generate Invite Link"}
                  </Button>
                </div>
                {invitesList && invitesList.length > 0 && (
                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {invitesList.map((inv) => {
                      const url = `${window.location.origin}/invite/${inv.token}`;
                      const isUsed = !!inv.usedAt;
                      const isExpired = new Date(inv.expiresAt) < new Date();
                      return (
                        <div key={inv.id} className={`p-3 rounded-lg border ${isUsed ? 'bg-muted/50 opacity-60' : isExpired ? 'bg-red-50/50 opacity-60' : 'bg-green-50/30'}`}>
                          <div className="flex items-center justify-between mb-1">
                            <Badge variant={inv.role === 'admin' ? 'default' : 'secondary'} className="text-xs">{inv.role}</Badge>
                            <div className="flex items-center gap-1">
                              {isUsed ? <Badge variant="outline" className="text-xs">Used</Badge> : isExpired ? <Badge variant="destructive" className="text-xs">Expired</Badge> : <Badge variant="outline" className="text-xs text-green-600">Active</Badge>}
                              {!isUsed && (
                                <Button variant="ghost" size="sm" onClick={() => deleteInvite.mutate({ id: inv.id })}>
                                  <Trash2 className="h-3 w-3 text-destructive" />
                                </Button>
                              )}
                            </div>
                          </div>
                          {!isUsed && !isExpired && (
                            <div className="flex items-center gap-2 mt-2">
                              <code className="text-xs bg-muted px-2 py-1 rounded flex-1 overflow-x-auto">{url}</code>
                              <Button variant="ghost" size="sm" onClick={() => { navigator.clipboard.writeText(url); toast.success("Copied!"); }}>
                                <Copy className="h-3 w-3" />
                              </Button>
                            </div>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">
                            Created {new Date(inv.createdAt).toLocaleDateString()} · Expires {new Date(inv.expiresAt).toLocaleDateString()}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Team Members */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Users className="h-4 w-4" /> Team Members
                  </CardTitle>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => purgeGhosts.mutate()}
                    disabled={purgeGhosts.isPending}
                    className="text-xs text-destructive border-destructive/40 hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3 w-3 mr-1" />
                    {purgeGhosts.isPending ? "Purging..." : "Purge Ghost Accounts"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {usersList && usersList.length > 0 ? (
                  <div className="space-y-2">
                    {usersList.map((u) => (
                      <div key={u.id} className="flex items-center justify-between p-3 rounded-lg border">
                        <div>
                          <p className="text-sm font-medium">{u.name || "Unnamed"}</p>
                          <p className="text-xs text-muted-foreground">{u.email || "No email"}</p>
                        </div>
                        <Select value={u.role} onValueChange={(v) => updateRole.mutate({ userId: u.id, role: v as "admin" | "viewer" })}>
                          <SelectTrigger className="w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="viewer">Viewer</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">No team members yet. Generate an invite link above.</p>
                )}
              </CardContent>
            </Card>

            {/* Agent Handoff Info */}
            <Card className="border-amber-200 bg-amber-50/30">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Shield className="h-4 w-4" /> Agent Handoff Rules
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-sm space-y-2">
                  <p className="text-muted-foreground">The AI brain automatically manages handoffs between itself and human agents:</p>
                  <div className="rounded-lg border bg-white p-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0">A</Badge>
                      <p className="text-xs">AI hands off when a lead needs a <strong>firm quote</strong> with specific quantities and pricing</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0">B</Badge>
                      <p className="text-xs">AI hands off when it detects an <strong>agent manually called or messaged</strong> the client</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0">C</Badge>
                      <p className="text-xs">AI <strong>resumes after 24 hours</strong> of no agent activity, picking up from the last conversation context</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0">D</Badge>
                      <p className="text-xs">On handoff, AI adds <strong>structured notes</strong> to the GHL contact (est. value, due date, preferences, key context)</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
