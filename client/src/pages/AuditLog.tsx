import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { Link } from "wouter";
import {
  Brain,
  Search,
  CheckCircle2,
  XCircle,
  RefreshCw,
  MessageSquare,
  Target,
  Lightbulb,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Ban,
  Bell,
  LifeBuoy,
} from "lucide-react";

type FilterTab = "all" | "approved" | "blocked" | "recomposed" | "violations";

export default function AuditLog() {
  const { data: auditEntries, isLoading } = trpc.ai.auditLog.useQuery({ limit: 100 });
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState<FilterTab>("all");

  const filtered = auditEntries?.filter((entry) => {
    // Tab filter
    if (activeTab === "approved" && (entry.qcApproved !== 1 || entry.blocked === 1)) return false;
    if (activeTab === "blocked" && entry.blocked !== 1) return false;
    if (activeTab === "recomposed" && entry.wasRecomposed !== 1) return false;
    if (activeTab === "violations" && !entry.violationCategory) return false;

    // Search filter
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      (entry.leadName || "").toLowerCase().includes(term) ||
      (entry.strategyApproach || "").toLowerCase().includes(term) ||
      (entry.strategyFramework || "").toLowerCase().includes(term) ||
      (entry.composedMessage || "").toLowerCase().includes(term) ||
      (entry.finalMessage || "").toLowerCase().includes(term) ||
      (entry.violationCategory || "").toLowerCase().includes(term) ||
      (entry.blockReason || "").toLowerCase().includes(term)
    );
  });

  const blockedCount = auditEntries?.filter((e) => e.blocked === 1).length || 0;
  const violationCount = auditEntries?.filter((e) => e.violationCategory).length || 0;
  const approvedCount = auditEntries?.filter((e) => e.qcApproved === 1 && e.blocked !== 1).length || 0;
  const recomposedCount = auditEntries?.filter((e) => e.wasRecomposed === 1).length || 0;
  const fallbackCount = auditEntries?.filter((e) => e.fallbackUsed === 1).length || 0;

  const tabs: { key: FilterTab; label: string; count: number; color: string }[] = [
    { key: "all", label: "All", count: auditEntries?.length || 0, color: "text-gray-700" },
    { key: "approved", label: "Approved", count: approvedCount, color: "text-green-700" },
    { key: "blocked", label: "Blocked", count: blockedCount, color: "text-red-700" },
    { key: "recomposed", label: "Recomposed", count: recomposedCount, color: "text-amber-700" },
    { key: "violations", label: "Violations", count: violationCount, color: "text-orange-700" },
  ];

  function violationLabel(cat: string): string {
    const labels: Record<string, string> = {
      irrelevant_research: "Irrelevant Research",
      form_data_ignored: "Form Data Ignored",
      wrong_business: "Wrong Business",
      generic_opener: "Generic Opener",
      missing_framework: "Missing Framework",
      safety_violation: "Safety Violation",
    };
    return labels[cat] || cat.replace(/_/g, " ");
  }

  function violationColor(cat: string): string {
    const colors: Record<string, string> = {
      irrelevant_research: "bg-orange-100 text-orange-800",
      form_data_ignored: "bg-red-100 text-red-800",
      wrong_business: "bg-red-100 text-red-800",
      generic_opener: "bg-amber-100 text-amber-800",
      missing_framework: "bg-yellow-100 text-yellow-800",
      safety_violation: "bg-red-200 text-red-900",
    };
    return colors[cat] || "bg-gray-100 text-gray-800";
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Brain className="h-7 w-7 text-purple-600" />
              Brain Council Audit Log
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Full accountability trail — every AI message is tracked, scored, and blocked if it fails quality checks
            </p>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by lead, violation, message..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm w-full sm:w-80 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Stats Row */}
        {auditEntries && auditEntries.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Card className="bg-white border-gray-200">
              <CardContent className="p-3 text-center">
                <div className="text-2xl font-bold text-gray-900">{auditEntries.length}</div>
                <div className="text-xs text-gray-500">Total Decisions</div>
              </CardContent>
            </Card>
            <Card className="bg-white border-green-200">
              <CardContent className="p-3 text-center">
                <div className="text-2xl font-bold text-green-600">{approvedCount}</div>
                <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                  <ShieldCheck className="h-3 w-3" /> Approved
                </div>
              </CardContent>
            </Card>
            <Card className={`bg-white ${blockedCount > 0 ? "border-red-300" : "border-gray-200"}`}>
              <CardContent className="p-3 text-center">
                <div className={`text-2xl font-bold ${blockedCount > 0 ? "text-red-600" : "text-gray-400"}`}>
                  {blockedCount}
                </div>
                <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                  <Ban className="h-3 w-3" /> Blocked
                </div>
              </CardContent>
            </Card>
            <Card className="bg-white border-gray-200">
              <CardContent className="p-3 text-center">
                <div className="text-2xl font-bold text-amber-600">{fallbackCount}</div>
                <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                  <LifeBuoy className="h-3 w-3" /> Fallbacks
                </div>
              </CardContent>
            </Card>
            <Card className="bg-white border-gray-200">
              <CardContent className="p-3 text-center">
                <div className="text-2xl font-bold text-purple-600">
                  {auditEntries.length > 0
                    ? Math.round(
                        auditEntries.reduce((sum, e) => sum + (e.qcScore || 0), 0) /
                          auditEntries.length
                      )
                    : 0}
                </div>
                <div className="text-xs text-gray-500">Avg QC Score</div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Filter Tabs */}
        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                activeTab === tab.key
                  ? "bg-white shadow-sm text-gray-900"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className={`ml-1.5 ${activeTab === tab.key ? tab.color : "text-gray-400"}`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Audit Entries */}
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="bg-white border-gray-200 animate-pulse">
                <CardContent className="p-6">
                  <div className="h-4 bg-gray-200 rounded w-1/3 mb-3" />
                  <div className="h-3 bg-gray-100 rounded w-2/3 mb-2" />
                  <div className="h-3 bg-gray-100 rounded w-1/2" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : !filtered || filtered.length === 0 ? (
          <Card className="bg-white border-gray-200">
            <CardContent className="p-12 text-center">
              <Brain className="h-12 w-12 text-gray-300 mx-auto mb-3" />
              <h3 className="text-lg font-medium text-gray-700">
                {activeTab === "all" ? "No audit entries yet" : `No ${activeTab} entries`}
              </h3>
              <p className="text-sm text-gray-500 mt-1">
                {activeTab === "blocked"
                  ? "No messages have been blocked yet. This is good!"
                  : "Brain Council decisions will appear here as the AI engages leads."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {filtered.map((entry) => {
              const isExpanded = expandedId === entry.id;
              const qcIssues = entry.qcIssues ? JSON.parse(entry.qcIssues) : [];
              const qcFeedback = entry.qcFeedback ? JSON.parse(entry.qcFeedback) : [];
              const isBlocked = entry.blocked === 1;

              return (
                <Card
                  key={entry.id}
                  className={`bg-white border transition-all cursor-pointer ${
                    isBlocked
                      ? "border-red-300 bg-red-50/30"
                      : isExpanded
                      ? "border-purple-300 shadow-md"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                >
                  <CardContent className="p-4">
                    {/* Collapsed Header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        {isBlocked ? (
                          <ShieldAlert className="h-5 w-5 text-red-500 shrink-0" />
                        ) : entry.qcApproved === 1 ? (
                          <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
                        ) : (
                          <XCircle className="h-5 w-5 text-amber-500 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Link
                              href={`/leads/${entry.leadId}`}
                              onClick={(e) => e.stopPropagation()}
                              className="font-semibold text-gray-900 hover:text-purple-600 truncate"
                            >
                              {entry.leadName || `Lead #${entry.leadId}`}
                            </Link>
                            <Badge variant="outline" className="text-xs shrink-0">
                              {entry.channel || "SMS"}
                            </Badge>
                            {isBlocked && (
                              <Badge className="bg-red-100 text-red-800 text-xs shrink-0">
                                <Ban className="h-3 w-3 mr-1" />
                                BLOCKED
                              </Badge>
                            )}
                            {entry.violationCategory && (
                              <Badge className={`text-xs shrink-0 ${violationColor(entry.violationCategory)}`}>
                                <AlertTriangle className="h-3 w-3 mr-1" />
                                {violationLabel(entry.violationCategory)}
                              </Badge>
                            )}
                            {entry.fallbackUsed === 1 && (
                              <Badge className="bg-blue-100 text-blue-700 text-xs shrink-0">
                                <LifeBuoy className="h-3 w-3 mr-1" />
                                Fallback
                              </Badge>
                            )}
                            {entry.ownerNotified === 1 && (
                              <Badge className="bg-yellow-100 text-yellow-700 text-xs shrink-0">
                                <Bell className="h-3 w-3 mr-1" />
                                Owner Notified
                              </Badge>
                            )}
                            {!isBlocked && (
                              <>
                                <Badge
                                  className={`text-xs shrink-0 ${
                                    entry.strategyApproach === "first_contact"
                                      ? "bg-blue-100 text-blue-700"
                                      : entry.strategyApproach === "follow_up"
                                      ? "bg-amber-100 text-amber-700"
                                      : entry.strategyApproach === "reactivation"
                                      ? "bg-purple-100 text-purple-700"
                                      : "bg-gray-100 text-gray-700"
                                  }`}
                                >
                                  {entry.strategyApproach || "unknown"}
                                </Badge>
                                <Badge variant="secondary" className="text-xs shrink-0">
                                  {entry.strategyFramework || "—"}
                                </Badge>
                                {entry.wasRecomposed === 1 && (
                                  <Badge className="bg-amber-100 text-amber-700 text-xs shrink-0">
                                    <RefreshCw className="h-3 w-3 mr-1" />
                                    Recomposed
                                  </Badge>
                                )}
                              </>
                            )}
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5 truncate max-w-xl">
                            {isBlocked
                              ? entry.blockReason || "Message blocked by QC"
                              : entry.finalMessage || entry.composedMessage || "—"}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-4">
                        <div className="text-right">
                          <div
                            className={`text-lg font-bold ${
                              isBlocked
                                ? "text-red-600"
                                : (entry.qcScore || 0) >= 80
                                ? "text-green-600"
                                : (entry.qcScore || 0) >= 60
                                ? "text-amber-600"
                                : "text-red-600"
                            }`}
                          >
                            {isBlocked ? "BLOCKED" : entry.qcScore || 0}
                          </div>
                          <div className="text-xs text-gray-400">{isBlocked ? "Violation" : "QC Score"}</div>
                        </div>
                        {isExpanded ? (
                          <ChevronUp className="h-5 w-5 text-gray-400" />
                        ) : (
                          <ChevronDown className="h-5 w-5 text-gray-400" />
                        )}
                      </div>
                    </div>

                    {/* Expanded Detail */}
                    {isExpanded && (
                      <div className="mt-4 pt-4 border-t border-gray-100 space-y-4">
                        {/* Timestamp & Lead Link */}
                        <div className="flex items-center justify-between text-xs text-gray-500">
                          <span>
                            {entry.createdAt
                              ? new Date(entry.createdAt).toLocaleString()
                              : "—"}
                          </span>
                          <Link
                            href={`/leads/${entry.leadId}`}
                            onClick={(e) => e.stopPropagation()}
                            className="flex items-center gap-1 text-purple-600 hover:text-purple-800"
                          >
                            View Lead <ExternalLink className="h-3 w-3" />
                          </Link>
                        </div>

                        {/* BLOCKED ALERT */}
                        {isBlocked && (
                          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                            <div className="flex items-center gap-2 text-sm font-semibold text-red-800 mb-2">
                              <ShieldAlert className="h-4 w-4" />
                              Message Blocked — {entry.violationCategory ? violationLabel(entry.violationCategory) : "QC Failure"}
                            </div>
                            {entry.blockReason && (
                              <p className="text-sm text-red-700 mb-2">{entry.blockReason}</p>
                            )}
                            {entry.ownerNotified === 1 && (
                              <div className="flex items-center gap-1.5 text-xs text-yellow-700 bg-yellow-50 rounded px-2 py-1 w-fit">
                                <Bell className="h-3 w-3" />
                                Owner was notified about this violation
                              </div>
                            )}
                          </div>
                        )}

                        {/* Blocked Message (what would have been sent) */}
                        {isBlocked && entry.composedMessage && (
                          <div className="bg-red-50/50 rounded-lg p-3 border border-red-100">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-red-600 mb-1">
                              <Ban className="h-3.5 w-3.5" />
                              Blocked Message (NOT sent)
                            </div>
                            <p className="text-sm text-gray-600 line-through whitespace-pre-wrap">
                              {entry.composedMessage}
                            </p>
                          </div>
                        )}

                        {/* Fallback Message (what was actually sent) */}
                        {entry.fallbackUsed === 1 && entry.fallbackMessage && (
                          <div className="bg-blue-50 rounded-lg p-3 border border-blue-200">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-blue-700 mb-1">
                              <LifeBuoy className="h-3.5 w-3.5" />
                              Safe Fallback (actually sent)
                            </div>
                            <p className="text-sm text-gray-800 whitespace-pre-wrap">
                              {entry.fallbackMessage}
                            </p>
                          </div>
                        )}

                        {/* Incoming Message */}
                        {entry.incomingMessage && (
                          <div className="bg-gray-50 rounded-lg p-3">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-gray-600 mb-1">
                              <MessageSquare className="h-3.5 w-3.5" />
                              Incoming Message (Trigger)
                            </div>
                            <p className="text-sm text-gray-800">{entry.incomingMessage}</p>
                          </div>
                        )}

                        {/* Strategy Decision */}
                        {entry.strategyApproach && (
                          <div className="bg-blue-50 rounded-lg p-3">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-blue-700 mb-1">
                              <Target className="h-3.5 w-3.5" />
                              Strategist Decision
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                              <div>
                                <span className="text-xs text-gray-500">Approach</span>
                                <p className="text-sm font-medium">{entry.strategyApproach || "—"}</p>
                              </div>
                              <div>
                                <span className="text-xs text-gray-500">Framework</span>
                                <p className="text-sm font-medium">{entry.strategyFramework || "—"}</p>
                              </div>
                              <div>
                                <span className="text-xs text-gray-500">Tier</span>
                                <p className="text-sm font-medium">{entry.strategyTier || "—"}</p>
                              </div>
                              <div>
                                <span className="text-xs text-gray-500">From</span>
                                <p className="text-sm font-medium">{entry.composerFromName || "—"}</p>
                              </div>
                            </div>
                            {entry.strategyReasoning && (
                              <p className="text-xs text-gray-600 italic">
                                {entry.strategyReasoning}
                              </p>
                            )}
                          </div>
                        )}

                        {/* Research Summary */}
                        {entry.researchSummary && (
                          <div className="bg-green-50 rounded-lg p-3">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-green-700 mb-1">
                              <Search className="h-3.5 w-3.5" />
                              Research Summary
                            </div>
                            <p className="text-sm text-gray-700">{entry.researchSummary}</p>
                          </div>
                        )}

                        {/* Composed Message (for non-blocked entries) */}
                        {!isBlocked && (
                          <div className="bg-purple-50 rounded-lg p-3">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-purple-700 mb-1">
                              <Lightbulb className="h-3.5 w-3.5" />
                              Composed Message
                            </div>
                            <p className="text-sm text-gray-800 whitespace-pre-wrap">
                              {entry.composedMessage || "—"}
                            </p>
                          </div>
                        )}

                        {/* QC Review */}
                        <div
                          className={`rounded-lg p-3 ${
                            isBlocked
                              ? "bg-red-50"
                              : entry.qcApproved === 1
                              ? "bg-green-50"
                              : "bg-amber-50"
                          }`}
                        >
                          <div
                            className={`flex items-center gap-1.5 text-xs font-medium mb-1 ${
                              isBlocked
                                ? "text-red-700"
                                : entry.qcApproved === 1
                                ? "text-green-700"
                                : "text-amber-700"
                            }`}
                          >
                            {isBlocked ? (
                              <ShieldAlert className="h-3.5 w-3.5" />
                            ) : entry.qcApproved === 1 ? (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5" />
                            )}
                            QC Review — Score: {entry.qcScore || 0}/100
                            {isBlocked && " — BLOCKED"}
                          </div>
                          {qcIssues.length > 0 && (
                            <div className="mb-2">
                              <span className="text-xs text-gray-500">Issues:</span>
                              <ul className="list-disc list-inside text-xs text-gray-700 mt-0.5">
                                {qcIssues.map((issue: string, i: number) => (
                                  <li key={i}>{issue}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {qcFeedback.length > 0 && (
                            <div>
                              <span className="text-xs text-gray-500">Suggestions:</span>
                              <ul className="list-disc list-inside text-xs text-gray-700 mt-0.5">
                                {qcFeedback.map((fb: string, i: number) => (
                                  <li key={i}>{fb}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>

                        {/* Final Message (if recomposed and not blocked) */}
                        {!isBlocked && entry.wasRecomposed === 1 && entry.finalMessage && (
                          <div className="bg-amber-50 rounded-lg p-3">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 mb-1">
                              <RefreshCw className="h-3.5 w-3.5" />
                              Final Message (After Recompose)
                              {entry.recomposeScore && (
                                <Badge variant="outline" className="ml-2 text-xs">
                                  Score: {entry.recomposeScore}
                                </Badge>
                              )}
                            </div>
                            <p className="text-sm text-gray-800 whitespace-pre-wrap">
                              {entry.finalMessage}
                            </p>
                          </div>
                        )}

                        {/* Send Status */}
                        {entry.sendError && (
                          <div className="bg-red-50 rounded-lg p-3">
                            <div className="text-xs font-medium text-red-700 mb-1">Send Error</div>
                            <p className="text-xs text-red-600 font-mono">{entry.sendError}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
