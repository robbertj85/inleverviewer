'use client';

import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  municipality: string;
  municipalityName: string;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard access can be blocked; the field is selectable as a fallback.
    }
  };

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex items-start gap-2">
        <textarea
          readOnly
          value={value}
          rows={value.length > 90 ? 3 : 1}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full resize-none rounded-lg border border-input bg-muted px-2.5 py-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button
          variant="outline"
          size="icon"
          onClick={copy}
          aria-label={`${label} kopiëren`}
          className="shrink-0"
        >
          {copied ? <CheckIcon className="size-4 text-primary" /> : <CopyIcon className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

export default function ShareModal({
  isOpen,
  onClose,
  municipality,
  municipalityName,
}: Props) {
  // Read once at mount rather than in an effect. The dialog body only renders
  // client-side (Radix mounts it on open), so there is no server render to
  // mismatch against.
  const [origin] = useState(() =>
    typeof window === 'undefined' ? '' : window.location.origin
  );

  // 'nederland' is exposed as 'alle-gemeenten' in URLs — it reads better and
  // matches the convention used by the pakketpunten viewer.
  const urlSlug = municipality === 'nederland' ? 'alle-gemeenten' : municipality;
  const shareUrl = `${origin}/?gemeente=${urlSlug}`;
  const embedUrl = `${origin}/embed?gemeente=${urlSlug}`;
  const embedCode = `<iframe src="${embedUrl}" width="100%" height="600" style="border:0;border-radius:12px" loading="lazy" title="Inleverpunten ${municipalityName}"></iframe>`;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Delen</DialogTitle>
          <DialogDescription>
            Deel de kaart van {municipalityName} of plaats hem op je eigen site.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <CopyField label="Link naar deze kaart" value={shareUrl} />
          <CopyField label="Embed-code (iframe)" value={embedCode} />

          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Voorbeeld</p>
            <div className="overflow-hidden rounded-lg border border-border">
              <iframe
                src={embedUrl}
                className="h-64 w-full"
                title={`Voorbeeld inleverpunten ${municipalityName}`}
                loading="lazy"
              />
            </div>
          </div>

          <p className="rounded-lg bg-secondary p-3 text-xs text-muted-foreground">
            Embedden is gratis en vrij toegestaan. Vermeld bij hergebruik de oorspronkelijke
            databronnen — die staan onder &lsquo;Over&rsquo;.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
