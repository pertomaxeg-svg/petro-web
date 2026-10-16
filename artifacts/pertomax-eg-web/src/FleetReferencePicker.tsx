import { useEffect, useId, useMemo, useState } from "react";
import {
  getGetAdminFleetCatalogQueryKey,
  getGetAdminFleetStockOptionsQueryKey,
  getGetAdminFleetSubscriptionOptionsQueryKey,
  getListBranchesPaginatedQueryKey,
  getListOrganizationsQueryKey,
  getListPlatformUsersQueryKey,
  useGetAdminFleetCatalog,
  useGetAdminFleetStockOptions,
  useGetAdminFleetSubscriptionOptions,
  useListBranchesPaginated,
  useListOrganizations,
  useListPlatformUsers,
} from "@workspace/api-client-react";
import type {
  GetAdminFleetCatalogParams,
  GetAdminFleetStockOptionsParams,
  GetAdminFleetSubscriptionOptionsParams,
  ListBranchesPaginatedParams,
  ListOrganizationsParams,
  ListPlatformUsersParams,
} from "@workspace/api-client-react";

type FleetReferenceKind =
  | "organization"
  | "branch"
  | "vehicle"
  | "driver"
  | "subscription"
  | "request"
  | "credential"
  | "policy"
  | "coverage"
  | "document"
  | "odometer"
  | "maintenance"
  | "link"
  | "platformUser"
  | "stockUnit";

type ReferenceRow = Record<string, unknown>;
type Option = { id: string; label: string; detail?: string; organizationId?: string };

function record(value: unknown): ReferenceRow {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ReferenceRow
    : {};
}

function rows(value: unknown): ReferenceRow[] {
  const root = record(value);
  const list = root.items ?? root.organizations ?? root.branches ?? root.users;
  return Array.isArray(list) ? list.map(record) : [];
}

function labelFor(kind: FleetReferenceKind, item: ReferenceRow): Option | null {
  const id = String(item.id ?? item.vehicleId ?? item.driverId ?? "");
  if (!id) return null;
  const code = String(item.code ?? item.driverCode ?? item.organizationCode ?? "");
  const plate = String(item.plateOriginal ?? item.plate ?? item.plateStandard ?? "");
  const name = String(item.name ?? item.fullName ?? item.displayName ?? "");
  const status = String(item.status ?? item.subscriptionStatus ?? "");
  const type = String(item.credentialType ?? item.type ?? "");
  const display: Partial<Record<FleetReferenceKind, string>> = {
    organization: name,
    branch: name,
    vehicle: [plate, item.brand, item.model].filter(Boolean).join(" — "),
    driver: name,
    subscription: [item.organizationName, item.branchName, item.planName].filter(Boolean).join(" — "),
    request: [plate, type, item.requestType].filter(Boolean).join(" — "),
    credential: [(item.tokenHint || item.hint) ? `رمز · ${item.tokenHint ?? item.hint}` : "رمز مركبة", type].filter(Boolean).join(" — "),
    policy: [`سياسة ${item.scope ?? ""}`, item.version ? `نسخة ${item.version}` : "", status].filter(Boolean).join(" — "),
    coverage: [plate, status, item.startsAt].filter(Boolean).join(" — "),
    document: [item.fileName, item.documentType ?? item.type].filter(Boolean).join(" — "),
    odometer: [item.readingKm ?? item.reading, item.recordedAt].filter(Boolean).join(" — "),
    maintenance: [item.maintenanceType ?? item.type, item.performedAt].filter(Boolean).join(" — "),
    link: [item.driverName, item.driverCode, status].filter(Boolean).join(" — "),
    platformUser: name,
    stockUnit: String(item.unitCode ?? ""),
  };
  const text = display[kind]?.trim();
  if (!text) return null;
  const organizationId = typeof item.organizationId === "string" ? item.organizationId : undefined;
  return { id, label: text, detail: code || status || undefined, organizationId };
}

function endpointFor(kind: FleetReferenceKind, query: string, organizationId?: string, vehicleId?: string) {
  const params = new URLSearchParams({ page: "1", pageSize: "20" });
  if (query.length >= 2) params.set(["organization", "platformUser", "branch"].includes(kind) ? "search" : "query", query);
  if (kind === "organization") {
    params.set("kind", "company");
    params.set("sortBy", "name");
    params.set("sortDirection", "asc");
    return `/api/organizations?${params}`;
  }
  if (kind === "branch") {
    if (!organizationId) return null;
    params.set("organizationId", organizationId);
    params.set("sortBy", "name");
    params.set("sortDirection", "asc");
    return `/api/branches?${params}`;
  }
  if (kind === "platformUser") return `/api/admin/platform-users?${params}`;
  if (kind === "subscription" || kind === "stockUnit") return null;
  const view: Partial<Record<FleetReferenceKind, string>> = {
    vehicle: "vehicles",
    driver: "drivers",
    request: "credentials",
    policy: "policies",
    coverage: "coverage",
    document: "documents",
    odometer: "odometer",
    maintenance: "maintenance",
    link: "vehicle",
  };
  if (kind === "credential" && vehicleId) {
    params.set("id", vehicleId);
    params.set("vehicleId", vehicleId);
    params.set("view", "vehicle");
    return `/api/admin/fleet/catalog?${params}`;
  }
  const selectedView = view[kind];
  if (!selectedView) return null;
  params.set("view", selectedView);
  if (organizationId) params.set("organizationId", organizationId);
  if (vehicleId) params.set("vehicleId", vehicleId);
  return `/api/admin/fleet/catalog?${params}`;
}

export function FleetReferencePicker({
  kind,
  name,
  value,
  onChange,
  organizationId,
  vehicleId,
  label,
  required = false,
  initialLabel,
  allowAll = false,
  emptyLabel = "اختر سجلًا",
  multiple = false,
  selectedValues = [],
  onValuesChange,
}: {
  kind: FleetReferenceKind;
  name?: string;
  value: string;
  onChange?: (value: string, option?: Option) => void;
  organizationId?: string;
  vehicleId?: string;
  label: string;
  required?: boolean;
  initialLabel?: string;
  allowAll?: boolean;
  emptyLabel?: string;
  multiple?: boolean;
  selectedValues?: string[];
  onValuesChange?: (values: string[], option?: Option) => void;
}) {
  const listId = useId();
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Option | null>(null);
  const [selectedLabels, setSelectedLabels] = useState<Record<string, Option>>({});
  const selectedValuesKey = selectedValues.join(",");
  const endpoint = endpointFor(kind, search.trim(), organizationId, vehicleId);
  const subscriptionParams: GetAdminFleetSubscriptionOptionsParams = {
    ...(organizationId ? { organizationId } : {}),
    ...(search.trim().length >= 2 ? { search: search.trim() } : {}),
    page: 1,
    pageSize: 20,
  };
  const stockParams: GetAdminFleetStockOptionsParams = {
    ...(search.trim().length >= 2 ? { search: search.trim() } : {}),
    page: 1,
    pageSize: 20,
  };
  const subscriptionQuery = useGetAdminFleetSubscriptionOptions(subscriptionParams, {
    query: {
      enabled: kind === "subscription" && Boolean(organizationId),
      queryKey: getGetAdminFleetSubscriptionOptionsQueryKey(subscriptionParams),
      retry: false,
    },
  });
  const stockQuery = useGetAdminFleetStockOptions(stockParams, {
    query: {
      enabled: kind === "stockUnit",
      queryKey: getGetAdminFleetStockOptionsQueryKey(stockParams),
      retry: false,
    },
  });
  const typedOptions = useMemo(() => {
    const data = kind === "subscription" ? subscriptionQuery.data
      : kind === "stockUnit" ? stockQuery.data
        : undefined;
    return rows(data).map((item) => labelFor(kind, item)).filter((item): item is Option => Boolean(item));
  }, [kind, subscriptionQuery.data, stockQuery.data]);
  const typedLoading = kind === "subscription" ? subscriptionQuery.isLoading
    : kind === "stockUnit" ? stockQuery.isLoading
      : false;
  const typedError = kind === "subscription" ? subscriptionQuery.error
    : kind === "stockUnit" ? stockQuery.error
      : null;

  useEffect(() => {
    if (!multiple) setSelected(null);
    setSearch("");
    setOptions([]);
    setLoading(false);
    setError("");
  }, [kind, organizationId, vehicleId, multiple]);

  useEffect(() => {
    if (multiple) return;
    if (value && selected?.id !== value) {
      setSelected(initialLabel ? { id: value, label: initialLabel } : null);
    } else if (!value) {
      setSelected(null);
    }
  }, [value, initialLabel, selected?.id, multiple]);

  useEffect(() => {
    if (kind !== "subscription" && kind !== "stockUnit") return;
    setOptions(typedOptions);
    setLoading(typedLoading);
    setError(typedError instanceof Error ? typedError.message : typedError ? "تعذر تحميل خيارات الاختيار." : "");
    if (multiple) {
      setSelectedLabels((current) => {
        const updated = { ...current };
        for (const option of typedOptions) {
          if (selectedValuesKey.split(",").includes(option.id)) updated[option.id] = option;
        }
        return updated;
      });
    }
    if (value) {
      const match = typedOptions.find((option) => option.id === value);
      if (match) setSelected(match);
    }
  }, [kind, typedOptions, typedLoading, typedError, multiple, selectedValuesKey, value]);

  useEffect(() => {
    if (kind === "subscription" || kind === "stockUnit") return;
    if (!endpoint || (kind === "organization" && search.trim().length < 2)) {
      setOptions([]);
      setLoading(false);
      setError("");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(endpoint, { credentials: "include", signal: controller.signal });
        const data: unknown = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(String(record(data).message ?? "تعذر تحميل خيارات الاختيار."));
        const root = record(data);
        const source = kind === "link" && Array.isArray(root.driverLinks)
          ? root.driverLinks.map(record)
          : kind === "credential" && Array.isArray(root.credentials)
            ? root.credentials.map(record)
            : rows(data);
        const next = source.map((item) => labelFor(kind, item)).filter((item): item is Option => Boolean(item));
        setOptions(next);
        if (multiple) {
          setSelectedLabels(current => {
            const updated = { ...current };
            for (const option of next) {
              if (selectedValuesKey.split(",").includes(option.id)) updated[option.id] = option;
            }
            return updated;
          });
        }
        if (value) {
          const match = next.find((option) => option.id === value);
          if (match) setSelected(match);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setOptions([]);
          setError(cause instanceof Error ? cause.message : "تعذر تحميل خيارات الاختيار.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [endpoint, kind, search, value, multiple, selectedValuesKey]);

  return <div className="fleet-reference-picker">
    {!multiple && selected && <div className="fleet-reference-selected"><span>{selected.label}</span>{selected.detail && <small>{selected.detail}</small>}
      <button type="button" onClick={() => { setSelected(null); onChange?.(""); }} aria-label={`مسح ${label}`}>تغيير</button>
    </div>}
    {multiple && <div className="fleet-reference-selected-set">
      {selectedValues.map(id => <span className="fleet-reference-chip" key={id}>
        {selectedLabels[id]?.label ?? "اختيار محفوظ"}
        <button type="button" onClick={() => { onValuesChange?.(selectedValues.filter(item => item !== id)); setSelectedLabels(current => { const next = { ...current }; delete next[id]; return next; }); }} aria-label={`إزالة اختيار من ${label}`}>×</button>
      </span>)}
      {!selectedValues.length && <small>لم تُحدد خيارات بعد؛ لا تعني القائمة الفارغة السماح العام.</small>}
    </div>}
    <label className="fleet-field">{label}
      <input type="search" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setOptions([]); }} placeholder={(kind === "branch" || kind === "subscription") && !organizationId ? "اختر الشركة أو المركبة أولًا" : selected ? "ابحث لاختيار سجل آخر" : emptyLabel} aria-label={label} aria-expanded={!!options.length} aria-controls={listId} autoComplete="off" disabled={(kind === "branch" || kind === "subscription") && !organizationId}/>
    </label>
    {name && <input type="hidden" name={name} value={multiple ? selectedValues.join(",") : value}/>}
    {allowAll && !multiple && <button type="button" className="fleet-reference-clear" onClick={() => { setSelected(null); onChange?.(""); }}>كل السجلات</button>}
    {loading && <small className="fleet-reference-state" role="status">جارٍ تحميل الخيارات…</small>}
    {error && <small className="fleet-reference-state is-error" role="alert">{error}</small>}
    {!loading && !error && !options.length && search.trim().length >= 2 && <small className="fleet-reference-state">لا توجد نتائج مطابقة.</small>}
     {!!options.length && <div id={listId} className="fleet-reference-options" role="listbox" aria-label={`نتائج ${label}`}>
       {options.map(option => {
         const alreadySelected = multiple && selectedValues.includes(option.id);
         return <button type="button" role="option" aria-selected={multiple ? alreadySelected : value === option.id} key={option.id} onClick={() => {
           if (multiple) {
             if (!alreadySelected) {
               onValuesChange?.([...selectedValues, option.id], option);
               setSelectedLabels(current => ({ ...current, [option.id]: option }));
             }
             setSearch("");
             setOptions([]);
             return;
           }
           setSelected(option); onChange?.(option.id, option); setSearch(""); setOptions([]);
         }}>
           <span>{alreadySelected ? `محدد: ${option.label}` : option.label}</span>{option.detail && <small>{option.detail}</small>}
         </button>;
       })}
    </div>}
  </div>;
}
