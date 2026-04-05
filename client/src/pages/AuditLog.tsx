import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
} from "lucide-react";

export default function AuditLog() {
  const { data: auditEntries, isLoading } = trpc.ai.auditLog.useQuery({ limit: 100 });
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  const filtered = auditEntries?.filter((entry) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      (entry.leadName || "").toLowerCase().includes(term) ||
      (entry.strategyApproach || "").toLowerCase().includes(term) ||
      (entry.strategyFramework || "").toLowerCase().includes(term) ||
      (entry.composedMessage || "").toLowerCase().includes(term) ||
      (entry.finalMessage || "").toLowerCase().includes(term)
    );
  });

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
              Full decision trail for every AI-generated message — Strategist → Researcher → Composer → QC
            </p>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by lead, framework, message..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm w-full sm:w-80 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Stats Row */}
        {auditEntries && auditEntries.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Card className="bg-white border-gray-200">
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-gray-900">{auditEntries.length}</div>
                <div className="text-xs text-gray-500">Total Decisions</div>
              </CardContent>
            </Card>
            <Card className="bg-white border-gray-200">
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-green-600">
                  {auditEntries.filter((e) => e.qcApproved === 1).length}
                </div>
                <div className="text-xs text-gray-500">QC Approved</div>
              </CardContent>
            </Card>
            <Card className="bg-white border-gray-200">
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-amber-600">
                  {auditEntries.filter((e) => e.wasRecomposed === 1).length}
                </div>
                <div className="text-xs text-gray-500">Recomposed</div>
              </CardContent>
            </Card>
            <Card className="bg-white border-gray-200">
              <CardContent className="p-4 text-center">
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
              <h3 className="text-lg font-medium text-gray-700">No audit entries yet</h3>
              <p className="text-sm text-gray-500 mt-1">
                Brain Council decisions will appear here as the AI engages leads.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {filtered.map((entry) => {
              const isExpanded = expandedId === entry.id;
              const qcIssues = entry.qcIssues ? JSON.parse(entry.qcIssues) : [];
              const qcFeedback = entry.qcFeedback ? JSON.parse(entry.qcFeedback) : [];

              return (
                <Card
                  key={entry.id}
                  className={`bg-white border transition-all cursor-pointer ${
                    isExpanded ? "border-purple-300 shadow-md" : "border-gray-200 hover:border-gray-300"
                  }`}
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                >
                  <CardContent className="p-4">
                    {/* Collapsed Header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        {entry.qcApproved === 1 ? (
                          <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
                        ) : (
                          <XCircle className="h-5 w-5 text-red-500 shrink-0" />
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
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5 truncate max-w-xl">
                            {entry.finalMessage || entry.composedMessage || "—"}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-4">
                        <div className="text-right">
                          <div
                            className={`text-lg font-bold ${
                              (entry.qcScore || 0) >= 80
                                ? "text-green-600"
                                : (entry.qcScore || 0) >= 60
                                ? "text-amber-600"
                                : "text-red-600"
                            }`}
                          >
                            {entry.qcScore || 0}
                          </div>
                          <div className="text-xs text-gray-400">QC Score</div>
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

                        {/* Composed Message */}
                        <div className="bg-purple-50 rounded-lg p-3">
                          <div className="flex items-center gap-1.5 text-xs font-medium text-purple-700 mb-1">
                            <Lightbulb className="h-3.5 w-3.5" />
                            Composed Message
                          </div>
                          <p className="text-sm text-gray-800 whitespace-pre-wrap">
                            {entry.composedMessage || "—"}
                          </p>
                        </div>

                        {/* QC Review */}
                        <div
                          className={`rounded-lg p-3 ${
                            entry.qcApproved === 1 ? "bg-green-50" : "bg-red-50"
                          }`}
                        >
                          <div
                            className={`flex items-center gap-1.5 text-xs font-medium mb-1 ${
                              entry.qcApproved === 1 ? "text-green-700" : "text-red-700"
                            }`}
                          >
                            {entry.qcApproved === 1 ? (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5" />
                            )}
                            QC Review — Score: {entry.qcScore}/100
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

                        {/* Final Message (if recomposed) */}
                        {entry.wasRecomposed === 1 && entry.finalMessage && (
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
