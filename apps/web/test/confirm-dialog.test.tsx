import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIRM_ARM_MS, ConfirmDialog } from "../src/components/ConfirmDialog";

function DeleteWithConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        削除
      </button>
      <ConfirmDialog
        open={open}
        title="削除しますか？"
        confirmLabel="削除する"
        danger
        onConfirm={() => {
          setOpen(false);
          onConfirm();
        }}
        onCancel={() => {
          setOpen(false);
          onCancel();
        }}
      />
    </>
  );
}

describe("ConfirmDialog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores its confirm button for the first CONFIRM_ARM_MS of every opening (a double click on the opener); cancel and Esc work at once", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<DeleteWithConfirm onConfirm={onConfirm} onCancel={onCancel} />);
    const opener = screen.getByRole("button", { name: "削除" });
    const dialog = () => screen.getByRole("alertdialog", { name: "削除しますか？" });
    const yes = () => within(dialog()).getByRole("button", { name: "削除する" }) as HTMLButtonElement;

    // The second click of a double click lands on 削除する right after the dialog opens.
    fireEvent.click(opener);
    expect(yes().getAttribute("aria-disabled")).toBe("true");
    // Not `disabled`: it stays in the focus order and keeps its look (no grey flash) while arming.
    expect(yes().disabled).toBe(false);
    expect(yes().hasAttribute("data-arming")).toBe(true);
    fireEvent.click(yes());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "やめる" }));

    // Cancelling is never held back.
    fireEvent.click(within(dialog()).getByRole("button", { name: "やめる" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // Time spent closed does not count: each opening arms afresh.
    act(() => vi.advanceTimersByTime(CONFIRM_ARM_MS * 2));
    fireEvent.click(opener);
    fireEvent.click(yes());
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(opener);
    act(() => vi.advanceTimersByTime(CONFIRM_ARM_MS - 1));
    fireEvent.click(yes());
    expect(onConfirm).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(yes().getAttribute("aria-disabled")).toBeNull();
    expect(yes().hasAttribute("data-arming")).toBe(false);
    fireEvent.click(yes());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
