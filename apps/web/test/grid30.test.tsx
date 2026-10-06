import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Grid30 } from "../src/components/Grid30";

describe("Grid30", () => {
  it("renders 30 named day buttons with the stamped state", () => {
    render(<Grid30 seal="写" stampedDays={[1, 3]} today={5} onCellClick={() => {}} />);
    expect(screen.getAllByRole("button")).toHaveLength(30);
    const day1 = screen.getByRole("button", { name: "1日目（済）" });
    expect(day1.getAttribute("aria-pressed")).toBe("true");
    expect(day1.textContent).toContain("写");
    expect(screen.getByRole("button", { name: "2日目" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("group", { name: "30日のカード" })).toBeTruthy();
  });

  it("marks today and fades/disables future days", () => {
    render(<Grid30 seal="写" stampedDays={[]} today={5} onCellClick={() => {}} />);
    const today = screen.getByRole("button", { name: "5日目" }) as HTMLButtonElement;
    expect(today.getAttribute("aria-current")).toBe("date");
    expect(today.className).toContain("today");
    expect(today.disabled).toBe(false);

    const future = screen.getByRole("button", { name: "6日目" }) as HTMLButtonElement;
    expect(future.disabled).toBe(true);
    expect(future.className).toContain("future");
    expect(screen.getAllByRole("button").filter((b) => (b as HTMLButtonElement).disabled)).toHaveLength(25);
  });

  it("calls onCellClick with the day, and not for future days", () => {
    const onCellClick = vi.fn();
    render(<Grid30 seal="写" stampedDays={[]} today={3} onCellClick={onCellClick} />);
    fireEvent.click(screen.getByRole("button", { name: "2日目" }));
    fireEvent.click(screen.getByRole("button", { name: "4日目" }));
    expect(onCellClick).toHaveBeenCalledTimes(1);
    expect(onCellClick).toHaveBeenCalledWith(2);
  });

  it("animates only the just-stamped cell", () => {
    const { container } = render(<Grid30 seal="歩" stampedDays={[1, 2]} today={2} justStamped={2} onCellClick={() => {}} />);
    expect(container.querySelectorAll(".st")).toHaveLength(2);
    expect(container.querySelectorAll(".st.new")).toHaveLength(1);
  });

  it("locked: no today marker, past cells still reach the handler (memos)", () => {
    const onCellClick = vi.fn();
    render(<Grid30 seal="写" stampedDays={[1]} today={30} locked onCellClick={onCellClick} />);
    expect(document.querySelector('[aria-current="date"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "1日目（済）" }));
    expect(onCellClick).toHaveBeenCalledWith(1);
  });

  it("is read-only without a click handler", () => {
    render(<Grid30 seal="写" stampedDays={[1]} today={10} />);
    expect(screen.getAllByRole("button").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("before the start every cell is in the future", () => {
    render(<Grid30 seal="写" stampedDays={[]} today={0} locked onCellClick={() => {}} />);
    expect(screen.getAllByRole("button").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});
