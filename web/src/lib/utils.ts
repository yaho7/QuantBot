import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** The Clipboard API needs HTTPS or localhost. Select the field on plain HTTP. */
export async function copyText(text: string, field: HTMLInputElement | HTMLTextAreaElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!field) return false;
    field.focus();
    field.select();
    return document.execCommand("copy");
  }
}
