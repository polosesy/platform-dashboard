// The live-diagram spec is generated once on the server and shared by every viewer, so it carries the
// stable token "Internet" instead of a translated name. Translate it where a label is shown.
// ("인터넷" is accepted too, for specs saved before the token was introduced.)

const INTERNET = /^(Internet|인터넷)$/;

/** Translate the "Internet" hop of a label like "AKS → Load Balancer (SNAT) → Internet". */
export function localizeLabel(label: string, t: (key: string) => string): string {
  return label
    .split(" → ")
    .map((part) => (INTERNET.test(part.trim()) ? t("ld.internet") : part))
    .join(" → ");
}
