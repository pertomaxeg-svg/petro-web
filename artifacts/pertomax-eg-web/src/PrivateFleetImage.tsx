import { useCallback, useEffect, useRef, useState } from "react";

export function PrivateFleetImage({ documentId, label, compact = false }: { documentId: string; label: string; compact?: boolean }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const request = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    setUrl("");
    setExpanded(false);
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/download`, { credentials: "include", signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.url !== "string") throw new Error("تعذر فتح الصورة الخاصة بصلاحية المستخدم الحالية.");
      if (!controller.signal.aborted) setUrl(data.url);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "تعذر تحميل الصورة.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [documentId]);
  useEffect(() => { void load(); return () => request.current?.abort(); }, [load]);
  useEffect(() => {
    if (!expanded || !url || !dialog.current) return;
    const element = dialog.current;
    element.showModal();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      element.close();
    };
  }, [expanded, url]);
  const failedImage = () => { setExpanded(false); setUrl(""); setError("انتهت صلاحية رابط المعاينة؛ أعد فتح الصورة."); };
  return <figure className={`fleet-private-image${compact ? " is-compact" : ""}`} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    {url ? <button type="button" className="fleet-private-image-zoom" aria-label={`تكبير ${label}`} onClick={() => setExpanded(true)}><img src={url} alt={label} loading="lazy" onError={failedImage}/></button> : <div className="fleet-private-image-empty" role={error ? "alert" : "status"}>{loading ? "جارٍ تحميل الصورة…" : error || "الصورة غير متاحة"}</div>}
    <figcaption>{label}<button type="button" className="fleet-row-action" onClick={() => void load()} disabled={loading}>{loading ? "جارٍ التحميل…" : "تحديث المعاينة"}</button></figcaption>
    {expanded && url && <dialog ref={dialog} className="fleet-image-lightbox" role="dialog" aria-modal="true" aria-label={`تكبير ${label}`} onCancel={event => { event.preventDefault(); setExpanded(false); }} onClick={event => { if (event.target === event.currentTarget) setExpanded(false); }}>
      <button type="button" autoFocus onClick={() => setExpanded(false)}>إغلاق الصورة</button>
      <img src={url} alt={label} onError={failedImage}/>
    </dialog>}
  </figure>;
}
