import { useEffect, useId, useMemo, useRef, useState } from "react";
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
type Option = { id: string; label: string; detail?: string; organizationId?: string; vehicleId?: string; version?: string; status?: string; paymentState?: string; hasProof?: boolean };

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
  const vehicleId = typeof item.vehicleId === "string" ? item.vehicleId : undefined;
  const version = item.version === undefined || item.version === null ? undefined : String(item.version);
  return {
    id, label: text, detail: code || status || undefined, organizationId, vehicleId, version, status: status || undefined,
    paymentState: typeof item.paymentState === "string" ? item.paymentState : undefined,
    hasProof: typeof item.proofDocumentId === "string" && Boolean(item.proofDocumentId),
  };
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
  error: fieldError,
  initialLabel,
  allowAll = false,
  emptyLabel = "اختر سجلًا",
  multiple = false,
  selectedValues = [],
  onValuesChange,
  allowedStatuses,
  requiresWaiver = false,
  requiresProof = false,
  testId,
}: {
  kind: FleetReferenceKind;
  name?: string;
  value: string;
  onChange?: (value: string, option?: Option) => void;
  organizationId?: string;
  vehicleId?: string;
  label: string;
  required?: boolean;
  error?: string;
  initialLabel?: string;
  allowAll?: boolean;
  emptyLabel?: string;
  multiple?: boolean;
  selectedValues?: string[];
  onValuesChange?: (values: string[], option?: Option) => void;
  allowedStatuses?: string[];
  requiresWaiver?: boolean;
  requiresProof?: boolean;
  testId?: string;
}) {
  const listId = useId();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Option | null>(null);
  const [selectedLabels, setSelectedLabels] = useState<Record<string, Option>>({});
  const selectedValuesKey = selectedValues.join(",");
  const labelSlug = label.trim().replace(/\s+/g, "-").replace(/[^\w\u0600-\u06FF-]/g, "");
  const controlId = testId ?? `fleet-reference-${name ?? `${kind}-${labelSlug}`}`;
  const queryText = search.trim().length >= 2 ? search.trim() : undefined;
  const organizationParams = useMemo<ListOrganizationsParams>(() => ({
    page: 1, pageSize: 20, kind: "company", sortBy: "name", sortDirection: "asc",
    ...(queryText ? { search: queryText } : {}),
  }), [queryText]);
  const branchParams = useMemo<ListBranchesPaginatedParams>(() => ({
    organizationId: organizationId ?? "", page: 1, pageSize: 20, sortBy: "name", sortDirection: "asc",
    ...(queryText ? { search: queryText } : {}),
  }), [organizationId, queryText]);
  const userParams = useMemo<ListPlatformUsersParams>(() => ({
    page: 1, pageSize: 20, ...(queryText ? { search: queryText } : {}),
  }), [queryText]);
  const ownerParams = useMemo<ListPlatformUsersParams>(() => ({ ...userParams, role: "owner" }), [userParams]);
  const operationsParams = useMemo<ListPlatformUsersParams>(() => ({ ...userParams, role: "operations" }), [userParams]);
  const catalogViews: Partial<Record<FleetReferenceKind, GetAdminFleetCatalogParams["view"]>> = {
    vehicle: "vehicles", driver: "drivers", request: "credentials",
    credential: vehicleId ? "vehicle" : "credentials", policy: "policies", coverage: "coverage",
    document: "documents", odometer: "odometer", maintenance: "maintenance", link: "vehicle",
  };
  const catalogView = catalogViews[kind];
  const catalogParams = useMemo<GetAdminFleetCatalogParams>(() => ({
    view: catalogView ?? "vehicles", page: 1, pageSize: 20,
    ...(queryText ? { query: queryText } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(allowedStatuses?.length === 1 ? { status: allowedStatuses[0] } : {}),
    ...(vehicleId ? { vehicleId, ...(catalogView === "vehicle" ? { id: vehicleId } : {}) } : {}),
  }), [catalogView, queryText, organizationId, vehicleId, kind, allowedStatuses]);
  const organizations = useListOrganizations(organizationParams, {
    query: { queryKey: getListOrganizationsQueryKey(organizationParams), enabled: kind === "organization", retry: false },
  });
  const branches = useListBranchesPaginated(branchParams, {
    query: { queryKey: getListBranchesPaginatedQueryKey(branchParams), enabled: kind === "branch" && Boolean(organizationId), retry: false },
  });
  const ownerUsers = useListPlatformUsers(ownerParams, {
    query: { queryKey: getListPlatformUsersQueryKey(ownerParams), enabled: kind === "platformUser", retry: false },
  });
  const operationsUsers = useListPlatformUsers(operationsParams, {
    query: { queryKey: getListPlatformUsersQueryKey(operationsParams), enabled: kind === "platformUser", retry: false },
  });
  const catalog = useGetAdminFleetCatalog(catalogParams, {
    query: { queryKey: getGetAdminFleetCatalogQueryKey(catalogParams), enabled: Boolean(catalogView) && !["organization", "branch", "platformUser"].includes(kind) && (kind !== "link" || Boolean(vehicleId)), retry: false },
  });
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
  const options = useMemo(() => {
    if (kind === "subscription" || kind === "stockUnit") return typedOptions;
    const root = record(catalog.data);
    const source = kind === "organization" ? rows(organizations.data)
      : kind === "branch" ? rows(branches.data)
      : kind === "platformUser" ? [...rows(ownerUsers.data), ...rows(operationsUsers.data)].filter((item, index, list) => list.findIndex(candidate => candidate.id === item.id) === index)
          : kind === "link" ? (Array.isArray(root.driverLinks) ? root.driverLinks.map(record) : [])
            : kind === "credential" && vehicleId && Array.isArray(root.credentials) ? root.credentials.map(record)
              : rows(catalog.data);
    const mapped = source.map(item => labelFor(kind, item)).filter((item): item is Option => Boolean(item));
    return mapped.filter(item =>
      (!allowedStatuses?.length || Boolean(item.status && allowedStatuses.includes(item.status)))
      && (!requiresWaiver || item.paymentState === "waived")
      && (!requiresProof || item.hasProof === true),
    );
  }, [kind, typedOptions, organizations.data, branches.data, ownerUsers.data, operationsUsers.data, catalog.data, vehicleId, allowedStatuses, requiresWaiver, requiresProof]);
  const loading = kind === "subscription" || kind === "stockUnit" ? typedLoading
    : kind === "organization" ? organizations.isLoading
      : kind === "branch" ? branches.isLoading
        : kind === "platformUser" ? ownerUsers.isLoading || operationsUsers.isLoading
          : catalog.isLoading;
  const errorValue = kind === "subscription" || kind === "stockUnit" ? typedError
    : kind === "organization" ? organizations.error
      : kind === "branch" ? branches.error
        : kind === "platformUser" ? ownerUsers.error ?? operationsUsers.error
          : catalog.error;
  const error = errorValue instanceof Error ? errorValue.message : errorValue ? "تعذر تحميل خيارات الاختيار." : "";
  const retryOptions = () => {
    if (kind === "subscription") void subscriptionQuery.refetch();
    else if (kind === "stockUnit") void stockQuery.refetch();
    else if (kind === "organization") void organizations.refetch();
    else if (kind === "branch") void branches.refetch();
    else if (kind === "platformUser") { void ownerUsers.refetch(); void operationsUsers.refetch(); }
    else void catalog.refetch();
  };

  useEffect(() => {
    setSearch("");
    setOpen(false);
    if (!multiple) setSelected(null);
  }, [kind, organizationId, vehicleId, multiple]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (multiple) {
      setSelectedLabels(current => {
        const updated = { ...current };
        for (const option of options) {
          if (selectedValuesKey.split(",").includes(option.id)) updated[option.id] = option;
        }
        return updated;
      });
      return;
    }
    if (!value) {
      setSelected(null);
      return;
    }
    const match = options.find(option => option.id === value);
    if (match) setSelected(match);
    else if (initialLabel) setSelected({ id: value, label: initialLabel });
    else if (selected?.id !== value) setSelected(null);
  }, [options, value, initialLabel, multiple, selectedValuesKey, selected?.id]);

  return <div ref={rootRef} className="fleet-reference-picker" onKeyDown={event => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setSearch("");
      document.getElementById(controlId)?.focus();
    }
  }}>
    {!multiple && selected && <div className="fleet-reference-selected"><span>{selected.label}</span>{selected.detail && <small>{selected.detail}</small>}
      <button type="button" data-testid={`${controlId}-clear`} onClick={() => { setSelected(null); onChange?.(""); }} aria-label={`مسح ${label}`}>تغيير</button>
    </div>}
    {multiple && <div className="fleet-reference-selected-set">
      {selectedValues.map((id, index) => <span className="fleet-reference-chip" key={id}>
        {selectedLabels[id]?.label ?? "اختيار محفوظ"}
        <button type="button" data-testid={`${controlId}-remove-${index}`} onClick={() => { onValuesChange?.(selectedValues.filter(item => item !== id)); setSelectedLabels(current => { const next = { ...current }; delete next[id]; return next; }); }} aria-label={`إزالة اختيار من ${label}`}>×</button>
      </span>)}
      {!selectedValues.length && <small>لم تُحدد خيارات بعد؛ لا تعني القائمة الفارغة السماح العام.</small>}
    </div>}
     <label className="fleet-field"><span className="fleet-field-label">{label}{required && <b className="fleet-required-mark">مطلوب</b>}</span>
        <input id={controlId} type="search" data-testid={`${controlId}-input`} value={search} onFocus={() => setOpen(true)} onChange={event => { setSearch(event.target.value); setOpen(true); }} onKeyDown={event => {
          if (event.key === "ArrowDown" && options.length) {
            event.preventDefault();
            setOpen(true);
            window.requestAnimationFrame(() => document.getElementById(listId)?.querySelector<HTMLButtonElement>("button")?.focus());
          }
        }} placeholder={(kind === "branch" || kind === "subscription") && !organizationId || kind === "link" && !vehicleId ? "اختر الشركة أو المركبة أولًا" : selected ? "ابحث لاختيار سجل آخر" : emptyLabel} aria-label={label} aria-required={required} aria-invalid={Boolean(fieldError)} aria-expanded={open && !!options.length} aria-controls={listId} autoComplete="off" disabled={(kind === "branch" || kind === "subscription") && !organizationId || kind === "link" && !vehicleId}/>
    </label>
     {fieldError && <small className="fleet-field-error" role="alert">{fieldError}</small>}
    {name && <input type="hidden" name={name} value={multiple ? selectedValues.join(",") : value}/>}
    {allowAll && !multiple && <button type="button" data-testid={`${controlId}-all`} className="fleet-reference-clear" onClick={() => { setSelected(null); onChange?.(""); }}>كل السجلات</button>}
    {loading && <small className="fleet-reference-state" role="status">جارٍ تحميل الخيارات…</small>}
     {error && <div className="fleet-reference-state is-error" role="alert">{error}<button type="button" data-testid={`${controlId}-retry`} onClick={retryOptions}>إعادة المحاولة</button></div>}
     {!loading && !error && !options.length && (search.trim().length >= 2 || allowedStatuses?.length || requiresWaiver || requiresProof) && <small className="fleet-reference-state">لا توجد سجلات مطابقة للشروط الحالية.</small>}
     {open && !!options.length && <div id={listId} className="fleet-reference-options" role="listbox" aria-label={`نتائج ${label}`}>
       {options.map((option, optionIndex) => {
         const alreadySelected = multiple && selectedValues.includes(option.id);
         return <button type="button" data-testid={`${controlId}-option-${optionIndex}`} role="option" aria-selected={multiple ? alreadySelected : value === option.id} key={option.id} onClick={() => {
           if (multiple) {
             if (!alreadySelected) {
               onValuesChange?.([...selectedValues, option.id], option);
               setSelectedLabels(current => ({ ...current, [option.id]: option }));
             }
             setSearch("");
             setOpen(false);
             return;
           }
            setSelected(option); onChange?.(option.id, option); setSearch(""); setOpen(false); document.getElementById(controlId)?.focus();
         }}>
           <span>{alreadySelected ? `محدد: ${option.label}` : option.label}</span>{option.detail && <small>{option.detail}</small>}
         </button>;
       })}
    </div>}
  </div>;
}
