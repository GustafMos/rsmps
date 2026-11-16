import { needsFfmpeg } from '../../io/export-codecs';
import { SelectField } from '../components/fields';
import { ffmpegInstalled, useAddons } from '../dialogs/AddonsSection';
import { useApp } from '../store/context';

/** Label text for an option, with the "needs FFmpeg add-on" tag when it goes through FFmpeg and FFmpeg is not set up. */
export function codecOptionLabel(value: string, label: string, ffmpegReady: boolean): string {
  return needsFfmpeg(value) && !ffmpegReady ? `${label} · needs FFmpeg add-on` : label;
}

/** True for an enum param that offers at least one FFmpeg-only video codec (the Output node's `codec`). */
export function hasFfmpegOptions(options: readonly { value: string }[]): boolean {
  return options.some((o) => needsFfmpeg(o.value));
}

/** The Output node's video-codec dropdown: FFmpeg-only formats carry a "needs FFmpeg add-on" tag until FFmpeg is installed. */
export function CodecSelect({ value, options, onChange, label }: { value: string; options: readonly { value: string; label: string }[]; onChange: (v: string) => void; label?: string }) {
  const { io } = useApp();
  const ready = ffmpegInstalled(useAddons(io));
  return <SelectField large value={value} options={options.map((o) => ({ ...o, label: codecOptionLabel(o.value, o.label, ready) }))} onChange={onChange} label={label} />;
}
