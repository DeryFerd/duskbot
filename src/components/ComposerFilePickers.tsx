// The composer's hidden file pickers. A phone or touch screen gets two more, so its + offers the photo library and the
// camera beside Files (an idea from Threebot, MIT); a desktop keeps the one picker.
import { useEffect, useRef, useState, type InputHTMLAttributes, type RefObject } from "react";

import { FILE_MAX_BYTES } from "@/lib/composer-attachments";
import type { AttachNotice } from "@/lib/intake-files";
import { t } from "@/lib/i18n";
import { nativeAttach, onAttachToComposer, PickProblem } from "@/lib/native-attach";
import { CARD_ACTION, ChatErrorCard } from "./ChatErrorBanner";
import { PHONE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";

/** A phone-width window or a touch-first screen. */
export const TOUCH_ATTACH = `${PHONE_LAYOUT}, (hover: none) and (pointer: coarse)`;

export interface AttachChoices { photos: () => void; camera: () => void }

export function useComposerFilePickers(onPick: (files: ArrayLike<File> | null) => void) {
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => onAttachToComposer((files) => pick.current(files)), []);
  const native = nativeAttach();
  const files = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const touch = useMediaQuery(TOUCH_ATTACH);
  const [problem, setProblem] = useState<PickProblem | null>(null);
  const pickNative = (pick: () => Promise<File[]>) => () => {
    setProblem(null);
    void pick().then(onPick, (error: unknown) => {
      if (!(error instanceof PickProblem)) return;
      if (error.files.length) onPick(error.files);
      setProblem(error);
    });
  };
  const pickPhotos = native ? pickNative(() => native.photos()) : () => photos.current?.click();
  const picker = (ref: RefObject<HTMLInputElement | null>, props: InputHTMLAttributes<HTMLInputElement>) => (
    <input
      ref={ref}
      type="file"
      className="hidden"
      onChange={(event) => {
        onPick(event.target.files);
        // reset so picking the same file again still fires onChange
        event.target.value = "";
      }}
      {...props}
    />
  );
  return {
    inputs: <>
      {picker(files, { multiple: true })}
      {touch && picker(photos, { multiple: true, accept: "image/*,video/*", "data-picker": "photos" } as InputHTMLAttributes<HTMLInputElement>)}
      {touch && picker(camera, { accept: "image/*", capture: "environment", "data-picker": "camera" } as InputHTMLAttributes<HTMLInputElement>)}
    </>,
    files: native ? () => void native.files().then(onPick, () => {}) : () => files.current?.click(),
    choices: touch ? {
      photos: pickPhotos,
      camera: native?.camera ? pickNative(() => native.camera!()) : () => camera.current?.click(),
    } satisfies AttachChoices : undefined,
    /** What the last photo pick left out, for the composer's error card. */
    problem,
    dismissProblem: () => setProblem(null),
    pickPhotosAgain: pickPhotos,
  };
}

/** What a photo pick left out: a title, one sentence and a way to pick again. */
export function PickProblemCard({ pickers }: { pickers: Pick<ReturnType<typeof useComposerFilePickers>, "problem" | "dismissProblem" | "pickPhotosAgain"> }) {
  const { problem } = pickers;
  if (!problem) return null;
  const tooLarge = problem.tooLarge.length > 0;
  return (
    <div className="pointer-events-auto mb-2 w-full" data-pick-problem="">
      <ChatErrorCard tone="warning" title={t(tooLarge ? "composer.attach.pickTooLargeTitle" : "composer.attach.pickFailedTitle")}
        onDismiss={pickers.dismissProblem}
        actions={<button type="button" className={CARD_ACTION} onClick={pickers.pickPhotosAgain}>
          {t(tooLarge ? "composer.attach.pickAgain" : "common.tryAgain")}
        </button>}>
        <p dir="auto" className="text-ink-secondary">
          {tooLarge
            ? t("composer.attach.tooLarge", { name: problem.tooLarge.join(", "), mb: FILE_MAX_BYTES / (1024 * 1024) })
            : t("composer.attach.pickFailedBody")}
        </p>
      </ChatErrorCard>
    </div>
  );
}

/** What an attach left out (a title, the files and why, and a way to pick again), or only news such as a photo sent as a
 * file. */
export function AttachNoticeCard({ notice, onDismiss, onPick }: { notice: AttachNotice; onDismiss: () => void; onPick: () => void }) {
  const problem = notice.tone === "warning";
  return (
    <div className="pointer-events-auto mb-2 w-full" data-attach-notice={notice.tone}>
      <ChatErrorCard tone={notice.tone} title={t(problem ? "composer.attach.noticeTitle" : "composer.attach.noticeInfoTitle")} onDismiss={onDismiss}
        actions={problem ? <button type="button" className={CARD_ACTION} onClick={onPick}>{t("composer.attach.chooseFiles")}</button> : undefined}>
        <p dir="auto" className="text-ink-secondary">{notice.text}</p>
      </ChatErrorCard>
    </div>
  );
}
