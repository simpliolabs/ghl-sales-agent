import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FolderOpen, Upload, Link2, Trash2, RefreshCw } from "lucide-react";
import { useState, useRef } from "react";
import { toast } from "sonner";

export default function KnowledgeBase() {
  const { data: files, isLoading, refetch } = trpc.knowledge.list.useQuery();
  const uploadMutation = trpc.knowledge.upload.useMutation({
    onSuccess: () => { toast.success("File uploaded"); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const addLinkMutation = trpc.knowledge.addGoogleSheet.useMutation({
    onSuccess: () => { toast.success("Google Sheet linked"); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const deleteMutation = trpc.knowledge.delete.useMutation({
    onSuccess: () => { toast.success("Removed"); refetch(); },
    onError: (e) => toast.error(e.message),
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
    if (!sheetUrl.trim()) { toast.error("Enter a Google Sheets URL"); return; }
    addLinkMutation.mutate({ url: sheetUrl.trim(), name: sheetName.trim() || "Price List" });
    setSheetUrl("");
    setSheetName("");
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FolderOpen className="h-6 w-6" /> Knowledge Base
          </h1>
          <p className="text-muted-foreground mt-1">Upload marketing materials and link pricing sheets for the AI brain</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* File Upload */}
          <Card>
            <CardHeader><CardTitle className="text-base">Upload Files</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">Upload PDFs, images, CSV, or XLSX files. The AI will reference these during conversations.</p>
              <input ref={fileInputRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.csv,.xlsx,.xls" onChange={handleFileUpload} className="hidden" />
              <Button onClick={() => fileInputRef.current?.click()} disabled={uploadMutation.isPending} className="w-full" variant="outline">
                <Upload className="h-4 w-4 mr-2" />
                {uploadMutation.isPending ? "Uploading..." : "Choose File"}
              </Button>
            </CardContent>
          </Card>

          {/* Google Sheets Link */}
          <Card>
            <CardHeader><CardTitle className="text-base">Link Google Sheet</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">Paste a Google Sheets URL. The AI will auto-sync pricing data on a schedule.</p>
              <Input placeholder="Sheet name (e.g., Price List)" value={sheetName} onChange={(e) => setSheetName(e.target.value)} />
              <Input placeholder="https://docs.google.com/spreadsheets/d/..." value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} />
              <Button onClick={handleAddSheet} disabled={addLinkMutation.isPending} className="w-full" variant="outline">
                <Link2 className="h-4 w-4 mr-2" />
                {addLinkMutation.isPending ? "Linking..." : "Link Sheet"}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Existing Files */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Uploaded Knowledge ({files?.length || 0})</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-12 w-full" />)}</div>
            ) : files && files.length > 0 ? (
              <div className="space-y-2">
                {files.map((f) => (
                  <div key={f.id} className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
                    <div className="flex items-center gap-3 min-w-0">
                      {f.googleSheetUrl ? <Link2 className="h-4 w-4 text-green-600 shrink-0" /> : <FolderOpen className="h-4 w-4 text-blue-600 shrink-0" />}
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{f.fileName}</p>
                        <p className="text-xs text-muted-foreground">{f.fileType} — {f.googleSheetUrl ? "Auto-synced" : "Uploaded"}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="text-xs">{f.googleSheetUrl ? "Sheet" : "File"}</Badge>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => deleteMutation.mutate({ id: f.id })}>
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">No files uploaded yet. Upload marketing materials or link a pricing sheet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
