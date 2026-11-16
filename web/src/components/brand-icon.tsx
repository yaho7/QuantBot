import { HStack } from "@astryxdesign/core/HStack";
import { ChartNoAxesCombined } from "lucide-react";
export function BrandIcon() {
  return <HStack padding={2} className="rounded-lg bg-accent text-on-accent" aria-hidden="true"><ChartNoAxesCombined size={20} /></HStack>;
}
