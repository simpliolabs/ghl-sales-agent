import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import {
  Webhook,
  Search,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

export default function WebhookLogs() {
  const { data: logs, isLoading } = trpc.ai.webhookLogs.useQuery({ limit: 100 });
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  const filtered = logs?.filter((log) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      (log.eventType || "").toLowerCase().includes(term) ||
      (log.detectedType || "").toLowerCase().includes(term) ||
      (log.contactId || "").toLowerCase().includes(term) ||
      (log.action || "").toLowerCase().includes(term) ||
      (log.payloadSummary || "").toLowerCase().includes(term)
    );
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Webhook className="h-7 w-7 text-indigo-600" />
              Webhook Event Logs
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Every incoming GHL webhook is logged here for diagnostics — track missed events, errors, and processing times.
            </p>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by type, contact, action..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm w-full sm:w-80 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Stats */}
        {logs && logs.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Card className="bg-white border-gray-200">
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-gray-900">{logs.length}</div>
                <div className="text-xs text-gray-500">Total Webhooks</div>
              </CardContent>
            </Card>
            <Card className="bg-white border-gray-200">
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-green-600">
                  {logs.filter((l) => !l.error).length}
                </div>
                <div className="text-xs text-gray-500">Successful</div>
              </CardContent>
            </Card>
            <Card className="bg-white border-gray-200">
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-red-600">
                  {logs.filter((l) => l.error).length}
                </div>
                <div className="text-xs text-gray-500">Errors</div>
              </CardContent>
            </Card>
            <Card className="bg-white border-gray-200">
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-indigo-600">
                  {logs.length > 0
                    ? Math.round(
                        logs.reduce((sum, l) => sum + (l.processingMs || 0), 0) / logs.length
                      )
                    : 0}
                  ms
                </div>
                <div className="text-xs text-gray-500">Avg Processing</div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Log Entries */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="bg-white border-gray-200 animate-pulse">
                <CardContent className="p-4">
                  <div className="h-4 bg-gray-200 rounded w-1/3 mb-2" />
                  <div className="h-3 bg-gray-100 rounded w-2/3" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : !filtered || filtered.length === 0 ? (
          <Card className="bg-white border-gray-200">
            <CardContent className="p-12 text-center">
              <Webhook className="h-12 w-12 text-gray-300 mx-auto mb-3" />
              <h3 className="text-lg font-medium text-gray-700">No webhook events logged yet</h3>
              <p className="text-sm text-gray-500 mt-1">
                Incoming GHL webhooks will be logged here automatically.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {filtered.map((log) => {
              const isExpanded = expandedId === log.id;
              let parsedPayload: Record<string, unknown> | null = null;
              try {
                parsedPayload = log.payloadSummary ? JSON.parse(log.payloadSummary) : null;
              } catch {
                // ignore
              }

              return (
                <Card
                  key={log.id}
                  className={`bg-white border transition-all cursor-pointer ${
                    isExpanded
                      ? "border-indigo-300 shadow-md"
                      : log.error
                      ? "border-red-200 hover:border-red-300"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                  onClick={() => setExpandedId(isExpanded ? null : log.id)}
                >
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        {log.error ? (
                          <XCircle className="h-4 w-4 text-red-500 shrink-0" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge
                              className={`text-xs ${
                                log.detectedType === "contact"
                                  ? "bg-blue-100 text-blue-700"
                                  : log.detectedType === "message"
                                  ? "bg-green-100 text-green-700"
                                  : log.detectedType === "pipeline"
                                  ? "bg-purple-100 text-purple-700"
                                  : "bg-gray-100 text-gray-700"
                              }`}
                            >
                              {log.detectedType || "unknown"}
                            </Badge>
                            <span className="text-xs text-gray-500">
                              {log.eventType || "—"}
                            </span>
                            {log.contactId && (
                              <span className="text-xs text-gray-400 font-mono truncate max-w-32">
                                {log.contactId}
                              </span>
                            )}
                            <span className="text-xs text-gray-400">→ {log.action || "—"}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-4">
                        <div className="flex items-center gap-1 text-xs text-gray-400">
                          <Clock className="h-3 w-3" />
                          {log.processingMs || 0}ms
                        </div>
                        <span className="text-xs text-gray-400">
                          {log.receivedAt
                            ? new Date(log.receivedAt).toLocaleString()
                            : "—"}
                        </span>
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4 text-gray-400" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-gray-400" />
                        )}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="mt-3 pt-3 border-t border-gray-100 space-y-3">
                        {log.error && (
                          <div className="bg-red-50 rounded p-2">
                            <span className="text-xs font-medium text-red-700">Error:</span>
                            <p className="text-xs text-red-600 font-mono mt-0.5">{log.error}</p>
                          </div>
                        )}
                        {parsedPayload && (
                          <div className="bg-gray-50 rounded p-2">
                            <span className="text-xs font-medium text-gray-600">
                              Payload Summary:
                            </span>
                            <pre className="text-xs text-gray-700 font-mono mt-1 whitespace-pre-wrap">
                              {JSON.stringify(parsedPayload, null, 2)}
                            </pre>
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
