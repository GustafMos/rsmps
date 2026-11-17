import { useEffect, useState } from 'react';
import { canEncodeAvif } from '../../io/encode';
import { encoderMissing, ffmpegOnlyCodec, needsFfmpeg, rowByValue } from '../../io/export-codecs';
import { SelectField } from '../components/fields';
import { ffmpegInstalled, useAddons } from '../dialogs/AddonsSection';
import { useApp } from '../store/context';

/** True when FFmpeg is set up but its build lacks the encoder this format needs (`encoders` null = not known: nothing is claimed). */
export function codecUnavailable(value: string, ffmpegReady: boolean, encoders?: readonly string[] | null): boolean {
  const c = ffmpegOnlyCodec(value);
  return !!c && ffmpegReady && encoderMissing(c, encoders);
}

/** Label text for an option: "needs FFmpeg add-on" while FFmpeg is not set up, "not in this FFmpeg" when its build lacks the encoder. */
export function codecOptionLabel(value: string, label: string, ffmpegReady: boolean, encoders?: readonly string[] | null): string {
  if (needsFfmpeg(value) && !ffmpegReady) return `${label} · needs FFmpeg add-on`;
  return codecUnavailable(value, ffmpegReady, encoders) ? `${label} · not in this FFmpeg` : label;
}

/** True for an enum param that offers at least one FFmpeg-only video codec (the Output node's `codec`). */
export function hasFfmpegOptions(options: readonly { value: string }[]): boolean {
  return options.some((o) => needsFfmpeg(o.value));
}

/** True once the browser has said it can encode AVIF stills (asked once per session). */
function useAvif(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let on = true;
    void canEncodeAvif().then((v) => on && setOk(v));
    return () => {
      on = false;
    };
  }, []);
  return ok;
}

/** The Output node's options that come from the format registry: `codec` (Video codec), `imageFormat` (Image format) and the Audio Output's `soundFormat`. */
export const REGISTRY_PARAMS: readonly string[] = ['codec', 'imageFormat', 'soundFormat'];

/**
 * A dropdown over the format registry: grouped by use, FFmpeg-only formats carry a "needs FFmpeg add-on" tag until FFmpeg is installed
 * and are disabled when the installed FFmpeg lacks their encoder. Formats the app writes itself carry no tag. AVIF is hidden where the
 * browser cannot encode it (unless it is the current choice).
 */
export function CodecSelect({ value, options, onChange, label }: { value: string; options: readonly { value: string; label: string }[]; onChange: (v: string) => void; label?: string }) {
  const { io } = useApp();
  const list = useAddons(io);
  const avif = useAvif();
  const ready = ffmpegInstalled(list);
  const encoders = list?.find((a) => a.id === 'ffmpeg')?.encoders ?? null;
  const shown = options.filter((o) => o.value !== 'avif' || avif || value === 'avif');
  return <SelectField large value={value} options={shown.map((o) => ({ ...o, label: codecOptionLabel(o.value, o.label, ready, encoders), disabled: codecUnavailable(o.value, ready, encoders), group: rowByValue(o.value)?.kind === 'audio' ? undefined : rowByValue(o.value)?.group }))} onChange={onChange} label={label} />;
}
