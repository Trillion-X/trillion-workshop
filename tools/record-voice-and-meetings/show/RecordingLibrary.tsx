import { lazyPart } from '../../ui/show/load-later/later';
import * as React from 'react';
import {RecordViews, type FieldDescriptor, type RecordView, type RecordViewContext, type SavedRecordView} from '../../ui/show/record-views/record-views';
import {Button} from '../../ui';
import {useRecordConfigurations, type RecordConfigurationBinding} from '../../ui/show/record-views/use-record-configurations';
import {formatFactValue} from '../../ui/show/fact-chips/FactChips';
import {extractFieldValue, type VisualDatabaseFieldDescriptor, type VisualDatabaseModel, type VisualDatabaseViewDescriptor} from '../../keep-lists-of-rows/read-data/visual-database';
import {removeRecording, setRecordingName, setRecordingNotes, setRecordingSubtitle} from '../do-work/record-audio-requests';
import library from '../read-data/recording-library.json';

export type RecordingLibraryConfiguration = RecordConfigurationBinding & {target: string; openPath: string};
export const recordingLibraryTarget = library.identity;
type ExpressionProps = Pick<React.ComponentProps<typeof import('../../keep-lists-of-rows/show/VisualDatabaseSurface').VisualDatabaseSurface>, 'cellExpressionInputs' | 'evaluatorDescriptors' | 'dispatchDerived'>;
type Props = ExpressionProps & {
  model: VisualDatabaseModel;
  onOpenRecording?: (recordingId: string) => void;
  configuration?: RecordingLibraryConfiguration;
  initialConfigurationId?: string;
  descriptorAuthorityError?: string;
  ruleOperators?: RecordViewsProps['ruleOperators'];
  loadFilterRecords?: RecordViewsProps['loadFilterRecords'];
  derivedReadProjection?: RecordViewsProps['derivedReadProjection'];
};
type RecordViewsProps = React.ComponentProps<typeof RecordViews>;
type LibraryData = typeof library;
const LegacySectionSurface = lazyPart(() => import('../../keep-lists-of-rows/show/VisualDatabaseSurface'), module => module.VisualDatabaseSurface);

const descriptorFor = (model: VisualDatabaseModel, id: string) => model.fields.find(field => field.id === id);
const knownLegacyIds = new Set((library as LibraryData).views.map(spec => spec.legacy_id));
function isCustomDescriptor(view: VisualDatabaseViewDescriptor): boolean {
  if (!knownLegacyIds.has(view.id)) return true;
  if (view.filters.length || view.gridStyle || view.rowStyle || view.sections?.length || view.presentation) return true;
  const spec = (library as LibraryData).views.find(candidate => candidate.legacy_id === view.id);
  if (view.columns) {
    const seededOrder = view.id === 'library-list' ? (library as LibraryData).legacy_column_order : undefined;
    const defaultOrder = seededOrder && JSON.stringify(view.columns.order ?? []) === JSON.stringify(seededOrder);
    if (!defaultOrder || view.columns.widths || view.columns.hidden?.length || Object.keys(view.columns.styles ?? {}).length) return true;
  }
  const defaultKinds = view.id === 'library-list' ? ['table', 'list'] : [spec?.kind];
  if (!defaultKinds.includes(view.kind)) return true;
  if (view.id === 'library-timeline' && (view.dateField !== spec?.date_field || view.zoom)) return true;
  return false;
}
function ruleKind(field: VisualDatabaseFieldDescriptor): string {
  if (field.domain?.values?.length) return 'choice';
  return 'text';
}

function fieldsFor(model: VisualDatabaseModel): FieldDescriptor[] {
  const data = library as LibraryData;
  const order = new Map(data.legacy_column_order.map((id, index) => [id, index]));
  return [...model.fields]
    .filter(field => field.role !== 'id' && field.role !== 'sort' && field.role !== 'link')
    .sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    .map(field => {
      const entry = data.fields.find(candidate => candidate.id === field.id);
      const displayKind = entry?.format;
      const factScale = typeof entry?.fact_scale === 'number' ? entry.fact_scale : 1;
      const kind = field.role === 'lane' || field.domain?.values?.length ? 'tag' : displayKind === 'duration' ? 'number' : displayKind === 'date' ? 'date' : 'text';
      const read = (record: unknown) => extractFieldValue(record as any, field);
      const factValue = (record: unknown) => {
        const value = read(record);
        if (value === null || value === undefined || value === '') return null;
        if (displayKind === 'date') {
          const time = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
          return Number.isFinite(time) ? time : null;
        }
        const number = Number(value);
        return Number.isFinite(number) ? number * factScale : null;
      };
      const render = displayKind
        ? (record: unknown) => formatFactValue({id: field.id, label: field.label, kind: displayKind}, factValue(record))
        : undefined;
      return {
        id: field.id,
        label: field.label,
        defaultExpression: field.defaultExpression,
        ...(field.domain?.values?.length ? {values: Object.fromEntries(field.domain.values.map(value => [value.id, {label: value.label, tone: value.tone}]))} : {}),
        kind,
        ruleKind: entry?.rule_kind ?? ruleKind(field),
        sortable: field.sortable !== false,
        filterable: field.filterable !== false,
        groupable: field.groupable !== false,
        hiddenByDefault: entry ? entry.default === false : true,
        width: entry?.width ?? 180,
        preview: field.role === 'title' ? 'heading' : false,
        document: entry?.document === true,
        editable: entry?.editable === true && field.editable !== false,
        read,
        ...(render ? {render} : {}),
        ...(displayKind ? {factValue} : {}),
        ...(displayKind ? {sortValue: (record: unknown) => {
          const value = read(record);
          return displayKind === 'date'
            ? (value instanceof Date ? value.getTime() : Date.parse(String(value ?? '')))
            : Number(value);
        }} : {}),
      };
    });
}

function viewsFor(model: VisualDatabaseModel, expressions: Pick<Props, 'cellExpressionInputs' | 'evaluatorDescriptors' | 'dispatchDerived'>): RecordView[] {
  const data = library as LibraryData;
  const ordinary = data.views.map(spec => {
    const legacy = model.views.find(candidate => candidate.id === spec.legacy_id);
    return {id: spec.id, label: legacy?.label ?? spec.label, icon: legacy?.icon, legacyOrder: legacy?.order ?? data.views.indexOf(spec)};
  });
  const custom = model.views.filter(view => view.visibility !== 'direct' && isCustomDescriptor(view)).map(view => ({
    id: `legacy-descriptor:${view.id}`,
    label: view.label,
    icon: view.icon,
    legacyOrder: view.order,
    render: ({records, open}: RecordViewContext) => {
      const sectionModel: VisualDatabaseModel = {
        ...model,
        records: records as VisualDatabaseModel['records'],
      };
      return <div>
        <div role="note" className="px-3 py-2 text-sm text-muted-foreground">
          This saved view is read only. Switch to List to edit recordings or remove them.
        </div>
        <React.Suspense fallback={<div role="status">Loading recording view…</div>}>
          <LegacySectionSurface model={sectionModel} {...expressions} presentation="section" initialViewId={view.id} onOpenRecord={record => open?.(String(record.id ?? ''))} onSelectNode={nodeRef => {
            const selected = records.find(record => {
              const source = record as any;
              return String(source?.id ?? '') === nodeRef || String(source?.address ?? source?.raw?.address ?? '') === nodeRef;
            });
            if (selected) open?.(String((selected as any).id ?? ''));
          }}/>
        </React.Suspense>
      </div>;
    },
  }));
  return [...ordinary, ...custom].sort((left, right) => left.legacyOrder - right.legacyOrder).map(({legacyOrder: _legacyOrder, ...view}) => view);
}

function defaultGroups(model: VisualDatabaseModel) {
  const data = library as LibraryData;
  const board = model.views.find(candidate => candidate.id === data.views.find(view => view.id === 'board')?.legacy_id);
  const field = board?.groupBy ?? data.views.find(view => view.id === 'board')?.group_field;
  return field && descriptorFor(model, field)?.groupable !== false ? [{field}] : [];
}

function legacyConfigurations(model: VisualDatabaseModel): SavedRecordView[] {
  return model.views.flatMap((view): SavedRecordView[] => {
    if (view.visibility === 'direct' || !isCustomDescriptor(view)) return [];
    const layout = `legacy-descriptor:${view.id}`;
    return [{
      id: `legacy-visual-database:${view.id}`,
      label: view.label,
      search: '',
      rules: {kind: 'group', combinator: 'and', negate: false, rules: []},
      display: {as: layout},
      readOnly: true,
      canRemove: false,
      canShare: false,
      owner: {id: 'visual-database.descriptors::record-audio', name: 'Recording view'},
    }];
  });
}

export function RecordingLibrary({model, onOpenRecording, configuration, initialConfigurationId, ruleOperators, loadFilterRecords, descriptorAuthorityError, derivedReadProjection, cellExpressionInputs, evaluatorDescriptors, dispatchDerived}: Props) {
  const [mutationError, setMutationError] = React.useState<string | undefined>();
  const fields = React.useMemo(() => fieldsFor(model), [model]);
  const offered = React.useMemo(() => viewsFor(model, {cellExpressionInputs, evaluatorDescriptors, dispatchDerived}), [model, cellExpressionInputs, evaluatorDescriptors, dispatchDerived]);
  const configs = useRecordConfigurations(configuration, configuration?.target, configuration?.openPath, fields);
  const [failedMutation, setFailedMutation] = React.useState<{operation: () => Promise<void>; message: string} | null>(null);
  const runMutation = React.useCallback(async (operation: () => Promise<void>) => {
    setMutationError(undefined);
    setFailedMutation(null);
    await operation();
  }, []);
  const mutationStatus = mutationError && failedMutation
    ? <div role="alert" className="flex items-center gap-2"><span>{mutationError}</span><Button variant="ghost" size="sm" onClick={() => void runMutation(failedMutation.operation).catch(() => {setMutationError(failedMutation.message);setFailedMutation(failedMutation)})}>Retry</Button></div>
    : undefined;
  const rowActions = React.useMemo<RecordViewsProps['rowActions']>(() => library.actions.flatMap(action => {
    if (action.operation !== 'open' && action.operation !== 'remove') return [];
    if (action.operation === 'open' && !onOpenRecording) return [];
    return [{...action, run: (ids: string[]) => {
      if (action.operation === 'open') { onOpenRecording?.(ids[0]!); return; }
      const operation = () => removeRecording({recordedFileId: ids[0]!});
      void runMutation(operation).catch(() => {setMutationError('The recording entry could not be removed.');setFailedMutation({operation, message: 'The recording entry could not be removed.'})});
    }}];
  }), [onOpenRecording, runMutation]);
  const options: RecordViewsProps = {
    label: library.label,
    identity: library.identity,
    preferenceKey: library.preference_key,
    fields,
    records: model.records,
    identify: record => String(record?.id ?? ''),
    views: offered,
    defaultView: 'table',
    defaultGroupLevels: defaultGroups(model),
    ruleOperators,
    loadFilterRecords,
    derivedReadProjection,
    onOpen: onOpenRecording,
    rowActions,
    onEditFieldValue: (recordId, fieldId, value) => {
      if (fieldId === 'recording-title') return runMutation(() => setRecordingName({recordedFileId: recordId, label: value}));
      if (fieldId === 'recording-subtitle') return runMutation(() => setRecordingSubtitle({recordedFileId: recordId, subtitle: value}));
      if (fieldId === 'recording-notes') return runMutation(() => setRecordingNotes({recordedFileId: recordId, notes: value}));
    },
    status: mutationStatus,
    emptyMessage: library.empty_message,
    ...configs,
    savedViews: [...legacyConfigurations(model), ...(configs.savedViews ?? [])],
    initialSavedViewId: initialConfigurationId ?? configs.initialSavedViewId ?? (() => {
      const list = model.views.find(view => view.id === 'library-list');
      return list && isCustomDescriptor(list) ? 'legacy-visual-database:library-list' : undefined;
    })(),
  };
  if (descriptorAuthorityError) return <div role="alert">{descriptorAuthorityError}</div>;
  return <RecordViews {...options}/>;
}
