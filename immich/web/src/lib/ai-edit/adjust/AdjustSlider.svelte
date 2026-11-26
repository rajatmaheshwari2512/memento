<!-- SelfPhotos Adjust: one slider. -->
<script lang="ts">
  interface Props {
    label: string;
    hideLabel?: boolean;
    value: number;
    min: number;
    max: number;
    step?: number;
    resetTo?: number;
    format?: (value: number) => string;
    disabled?: boolean;
    onChange: (value: number) => void;
  }

  let {
    label,
    hideLabel = false,
    value,
    min,
    max,
    step = 1,
    resetTo = 0,
    format = (v) => (v > 0 ? `+${v}` : String(v)),
    disabled = false,
    onChange,
  }: Props = $props();

  const id = $props.id();
</script>

<div class={hideLabel ? 'flex' : 'mb-3 text-sm text-white'}>
  {#if !hideLabel}
    <div class="flex justify-between">
      <label for={id}>{label}</label>
      <span class="tabular-nums">{format(value)}</span>
    </div>
  {/if}
  <input
    {id}
    aria-label={hideLabel ? label : undefined}
    class={['h-4 w-full accent-immich-dark-primary', !hideLabel && 'mt-2']}
    type="range"
    {min}
    {max}
    {step}
    {value}
    {disabled}
    oninput={(event) => onChange(Number(event.currentTarget.value))}
    ondblclick={() => onChange(resetTo)}
  />
</div>
