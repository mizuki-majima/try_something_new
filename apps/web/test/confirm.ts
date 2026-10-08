import { waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { CONFIRM_ARM_MS } from "../src/components/ConfirmDialog";

/**
 * A ConfirmDialog's confirm button once it takes presses: it ignores them (aria-disabled) for its first
 * CONFIRM_ARM_MS, so the second tap of a double tap on the opener cannot confirm. Waits in real time.
 */
export async function armed(button: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull(), { timeout: CONFIRM_ARM_MS + 2000 });
  return button;
}
