import {useEffect,useState} from 'react';
import type {AntigravityModel,AntigravityModelGroup,Json} from '../src/shared/types';
import {modelDisplayName,reasoningLabel,resolveModelSelection,type ModelSelection} from '../src/shared/models';
import {ModelMenu} from './model-picker';

export type AntigravityCatalog = {
  models: AntigravityModel[];
  groups?: AntigravityModelGroup[];
  current: string | null;
  defaultModel?: string;
  supportsImages?: boolean;
  defaultPermissionMode?: string;
};

/** Maps Antigravity's model catalog into the Codex/Claude-shaped list `ModelMenu` expects. */
export function antigravityPickerModels(catalog: AntigravityCatalog | null): Json[] {
  if (!catalog) return [];
  if (catalog.groups?.length) {
    return catalog.groups.map(group => ({
      model: group.id,
      displayName: group.label,
      description: group.description,
      supportedReasoningEfforts: (group.efforts || []).map(level => ({reasoningEffort: level})),
      ...(group.defaultEffort ? {defaultReasoningEffort: group.defaultEffort} : {}),
    }));
  }
  return (catalog.models || []).map(model => ({
    model: model.id,
    displayName: model.label,
    description: model.description,
    supportedReasoningEfforts: [],
  }));
}

/** Splits a concrete Antigravity `planModel` ID (e.g. `MODEL_PLACEHOLDER_M532`) into `(groupId, effort)`. */
export function splitAntigravityModel(catalog: AntigravityCatalog | null, concreteId: string | null | undefined): {model: string; effort: string} {
  if (!concreteId) return {model: '', effort: ''};
  if (catalog?.groups?.length) {
    for (const group of catalog.groups) {
      if (group.variants) {
        for (const [effort, variantId] of Object.entries(group.variants)) {
          if (variantId === concreteId) return {model: group.id, effort};
        }
      }
      if (group.id === concreteId) return {model: group.id, effort: ''};
    }
  }
  return {model: concreteId, effort: ''};
}

/** Resolves a picker `(groupId, effort)` back to the concrete `planModel` ID Antigravity expects. */
export function concreteAntigravityModel(catalog: AntigravityCatalog | null, selection: {model: string; effort: string}): string {
  if (!selection.model) return '';
  if (catalog?.groups?.length) {
    const group = catalog.groups.find(item => item.id === selection.model);
    if (group?.variants) {
      return (selection.effort && group.variants[selection.effort])
        || (group.defaultEffort && group.variants[group.defaultEffort])
        || Object.values(group.variants)[0]
        || '';
    }
    if (group) return group.id;
  }
  return selection.model;
}

/** Whether the selected (or current) Antigravity model accepts images; null until the catalog is known. */
export function antigravityModelSupportsImages(catalog: AntigravityCatalog | null, concreteId: string | null | undefined): boolean | null {
  if (!catalog) return null;
  const target = concreteId || catalog.current || catalog.defaultModel || '';
  if (target) {
    const entry = catalog.models.find(model => model.id === target);
    if (entry && entry.supportsImages !== undefined) return entry.supportsImages;
    const group = catalog.groups?.find(item => item.id === target || (item.variants && Object.values(item.variants).includes(target)));
    if (group && group.supportsImages !== undefined) return group.supportsImages;
  }
  return Boolean(catalog.supportsImages);
}

type Props = {
  read: () => Promise<AntigravityCatalog>;
  /** Last catalog cached for this computer, so the toolbar shows the model name before the Hub responds. */
  cached?: AntigravityCatalog | null;
  turn: string;
  value: string;
  available: boolean;
  disabled: boolean;
  onChange: (concreteId: string) => void;
  onCatalog?: (catalog: AntigravityCatalog) => void;
};

/**
 * Unified model & thinking-level picker for Antigravity, matching Claude Code's `ModelMenu` UX:
 * grouped models with a thinking-effort slider, concrete model + effort on the toolbar button,
 * and automatic fallback to a flat list for older connectors without `groups`.
 */
export function AntigravityModelPicker({read, cached = null, turn, value, available, disabled, onChange, onCatalog}: Props) {
  const [catalog, setCatalog] = useState<AntigravityCatalog | null>(cached);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!available) return;
    let active = true;
    setError('');
    read().then(result => {
      if (!active) return;
      setCatalog(result);
      onCatalog?.(result);
    }).catch(failure => {
      if (!active) return;
      setError(failure?.message || '模型列表读取失败');
    });
    return () => { active = false; };
  }, [read, turn, refresh, available]);

  const pickerModels = antigravityPickerModels(catalog);
  const tuning = Boolean(catalog?.groups?.some(group => group.efforts && group.efforts.length > 0));
  const currentConcrete = catalog?.current || catalog?.defaultModel || '';
  const currentSplit = splitAntigravityModel(catalog, currentConcrete);
  const valueSplit = splitAntigravityModel(catalog, value);
  const currentModel = {
    model: currentSplit.model || pickerModels[0]?.model || '',
    effort: currentSplit.effort || '',
  };
  const resolved = resolveModelSelection(pickerModels, {model: valueSplit.model, effort: valueSplit.effort}, currentModel);
  const sentEffort = resolved.efforts.length ? resolved.effort : '';
  const modelLabel = modelDisplayName(resolved.model, resolved.id) || (value ? (catalog ? '所选模型已不可用' : '已选模型') : '选择模型');
  const effortLabel = tuning ? reasoningLabel(sentEffort) : '';
  const flatCurrentLabel = catalog?.models.find(model => model.id === catalog.current)?.label;

  function handleChange(next: ModelSelection) {
    if (!tuning) {
      onChange(next.model);
      return;
    }
    const targetModel = next.model || currentModel.model;
    const targetEffort = next.effort || currentModel.effort;
    const concrete = concreteAntigravityModel(catalog, {model: targetModel, effort: targetEffort});
    // Choosing the conversation's own concrete model clears any override, matching Claude Code.
    onChange(concrete && catalog?.current && concrete === catalog.current ? '' : concrete);
  }

  return <ModelMenu
    label={modelLabel}
    details={effortLabel ? [effortLabel] : []}
    title="选择 Antigravity 模型"
    tuning={tuning}
    speed={false}
    resettable={false}
    disabled={disabled}
    unavailable={!available}
    opened={() => setRefresh(n => n + 1)}
    models={pickerModels}
    value={{model: valueSplit.model, effort: valueSplit.effort}}
    current={currentModel}
    currentLabel={flatCurrentLabel}
    onChange={handleChange}
    status={error ? <p role="alert">{error} <button type="button" onClick={() => setRefresh(n => n + 1)}>重试</button></p>
      : !catalog ? <p role="status">正在读取桌面模型…</p> : !pickerModels.length && <p role="status">桌面暂无可选模型</p>}/>;
}
