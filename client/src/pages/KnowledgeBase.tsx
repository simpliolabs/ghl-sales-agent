import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FolderOpen,
  Upload,
  Link2,
  Trash2,
  ChevronDown,
  ChevronRight,
  Pencil,
  Save,
  X,
  Sparkles,
  FileText,
  Clock,
} from "lucide-react";
import { useState, useRef, useCallback } from "react";
import { toast } from "sonner";

type KBFile = {
  id: number;
  fileName: string;
  fileType: string;
  fileUrl?: string | null;
  googleSheetUrl?: string | null;
  contentText?: string | null;
  lastSyncedAt?: string | Date | null;
  createdAt: string | Date;
};

function formatDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function KBEntry({
  file,
  onDelete,
  onSave,
  onResynthesize,
  isSaving,
  isResynthesizing,
}: {
  file: KBFile;
  onDelete: (id: number) => void;
  onSave: (id: number, content: string) => void;
  onResynthesize: (id: number) => void;
  isSaving: boolean;
  isResynthesizing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(file.contentText || "");

  const handleExpand = useCallback(() => {
    setExpanded((prev) => !prev);
    if (!expanded) {
      setDraft(file.contentText || "");
      setEditing(false);
    }
  }, [expanded, file.contentText]);

  const handleEdit = useCallback(() => {
    setDraft(file.contentText || "");
    setEditing(true);
  }, [file.contentText]);

  const handleCancel = useCallback(() => {
    setDraft(file.contentText || "");
    setEditing(false);
  }, [file.contentText]);

  const handleSave = useCallback(() => {
    onSave(file.id, draft);
    setEditing(false);
  }, [file.id, draft, onSave]);

  const contentPreview = file.contentText
    ? file.contentText.length > 120
      ? file.contentText.substring(0, 120) + "..."
      : file.contentText
    : null;

  const wordCount = file.contentText
    ? file.contentText.split(/\s+/).filter(Boolean).length
    : 0;

  return (
    <div className="rounded-lg border bg-card text-card-foreground overflow-hidden">
      {/* Header row — always visible */}
      <button
        type="button"
        onClick={handleExpand}
        className="w-full flex items-center gap-3 p-3 hover:bg-muted/50 transition-colors text-left"
      >
        <span className="shrink-0 text-muted-foreground">
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </span>

        {file.googleSheetUrl ? (
          <Link2 className="h-4 w-4 text-green-600 shrink-0" />
        ) : (
          <FolderOpen className="h-4 w-4 text-blue-600 shrink-0" />
        )}

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{file.fileName}</p>
          {!expanded && contentPreview && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {contentPreview}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {wordCount > 0 && (
            <Badge variant="secondary" className="text-xs font-normal">
              <FileText className="h-3 w-3 mr-1" />
              {wordCount.toLocaleString()} words
            </Badge>
          )}
          <Badge variant="outline" className="text-xs">
            {file.googleSheetUrl ? "Sheet" : "File"}
          </Badge>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-3">
          {/* Metadata row */}
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Uploaded: {formatDate(file.createdAt)}
            </span>
            {file.lastSyncedAt && (
              <span className="flex items-center gap-1">
                <Pencil className="h-3 w-3" />
                Last edited: {formatDate(file.lastSyncedAt)}
              </span>
            )}
            {file.fileUrl && (
              <a
                href={file.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                View original file
              </a>
            )}
            {file.googleSheetUrl && (
              <a
                href={file.googleSheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-green-600 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                Open Google Sheet
              </a>
            )}
          </div>

          {/* Content area */}
          {editing ? (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                Synthesized Content (AI-readable)
              </label>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="w-full min-h-[240px] rounded-md border bg-background px-3 py-2 text-sm font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="Enter synthesized content the AI will reference during conversations..."
                autoFocus
              />
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {draft.split(/\s+/).filter(Boolean).length.toLocaleString()}{" "}
                  words
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCancel}
                    disabled={isSaving}
                  >
                    <X className="h-3.5 w-3.5 mr-1" />
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={isSaving || draft === (file.contentText || "")}
                  >
                    <Save className="h-3.5 w-3.5 mr-1" />
                    {isSaving ? "Saving..." : "Save Changes"}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {file.contentText ? (
                <pre className="whitespace-pre-wrap text-sm leading-relaxed bg-muted/40 rounded-md p-3 max-h-[400px] overflow-y-auto font-sans">
                  {file.contentText}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground italic py-4 text-center">
                  No synthesized content yet. Click "Edit" to add content or
                  "Re-synthesize" to auto-generate from the original file.
                </p>
              )}
            </div>
          )}

          {/* Action buttons */}
          {!editing && (
            <div className="flex items-center justify-between pt-1">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleEdit}>
                  <Pencil className="h-3.5 w-3.5 mr-1" />
                  Edit Content
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onResynthesize(file.id)}
                  disabled={isResynthesizing}
                >
                  <Sparkles className="h-3.5 w-3.5 mr-1" />
                  {isResynthesizing ? "Synthesizing..." : "Re-synthesize"}
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => onDelete(file.id)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Delete
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function KnowledgeBase() {
  const { data: files, isLoading, refetch } = trpc.knowledge.list.useQuery();
  const uploadMutation = trpc.knowledge.upload.useMutation({
    onSuccess: () => {
      toast.success("File uploaded and synthesized");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const addLinkMutation = trpc.knowledge.addGoogleSheet.useMutation({
    onSuccess: () => {
      toast.success("Google Sheet linked");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteMutation = trpc.knowledge.delete.useMutation({
    onSuccess: () => {
      toast.success("Removed");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const updateMutation = trpc.knowledge.updateContent.useMutation({
    onSuccess: () => {
      toast.success("Content saved");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const resynthesizeMutation = trpc.knowledge.resynthesize.useMutation({
    onSuccess: () => {
      toast.success("Content re-synthesized from original file");
      refetch();
    },
    onError: (e: { message: string }) => toast.error(e.message),
  });

  const [sheetUrl, setSheetUrl] = useState("");
  const [sheetName, setSheetName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1];
      uploadMutation.mutate({
        fileName: file.name,
        fileType: file.type || "application/octet-stream",
        fileData: base64 || "",
      });
    };
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleAddSheet = () => {
    if (!sheetUrl.trim()) {
      toast.error("Enter a Google Sheets URL");
      return;
    }
    addLinkMutation.mutate({
      url: sheetUrl.trim(),
      name: sheetName.trim() || "Price List",
    });
    setSheetUrl("");
    setSheetName("");
  };

  const handleSave = useCallback(
    (id: number, content: string) => {
      updateMutation.mutate({ id, contentText: content });
    },
    [updateMutation]
  );

  const handleResynthesize = useCallback(
    (id: number) => {
      resynthesizeMutation.mutate({ id });
    },
    [resynthesizeMutation]
  );

  const handleDelete = useCallback(
    (id: number) => {
      deleteMutation.mutate({ id });
    },
    [deleteMutation]
  );

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FolderOpen className="h-6 w-6" /> Knowledge Base
          </h1>
          <p className="text-muted-foreground mt-1">
            Upload marketing materials and link pricing sheets. Click any entry
            to view and edit its synthesized content.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* File Upload */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Upload Files</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Upload PDFs, images, CSV, or XLSX files. The AI will
                auto-synthesize and reference these during conversations.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.csv,.xlsx,.xls"
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadMutation.isPending}
                className="w-full"
                variant="outline"
              >
                <Upload className="h-4 w-4 mr-2" />
                {uploadMutation.isPending
                  ? "Uploading & Synthesizing..."
                  : "Choose File"}
              </Button>
            </CardContent>
          </Card>

          {/* Google Sheets Link */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Link Google Sheet</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Paste a Google Sheets URL. The AI will auto-sync pricing data on
                a schedule.
              </p>
              <Input
                placeholder="Sheet name (e.g., Price List)"
                value={sheetName}
                onChange={(e) => setSheetName(e.target.value)}
              />
              <Input
                placeholder="https://docs.google.com/spreadsheets/d/..."
                value={sheetUrl}
                onChange={(e) => setSheetUrl(e.target.value)}
              />
              <Button
                onClick={handleAddSheet}
                disabled={addLinkMutation.isPending}
                className="w-full"
                variant="outline"
              >
                <Link2 className="h-4 w-4 mr-2" />
                {addLinkMutation.isPending ? "Linking..." : "Link Sheet"}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Knowledge Entries */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Uploaded Knowledge ({files?.length || 0})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : files && files.length > 0 ? (
              <div className="space-y-2">
                {(files as KBFile[]).map((f) => (
                  <KBEntry
                    key={f.id}
                    file={f}
                    onDelete={handleDelete}
                    onSave={handleSave}
                    onResynthesize={handleResynthesize}
                    isSaving={updateMutation.isPending}
                    isResynthesizing={resynthesizeMutation.isPending}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">
                No files uploaded yet. Upload marketing materials or link a
                pricing sheet.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
