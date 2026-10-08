/**
 * 「えらぶ」 (#20): the tab holds two ways to pick the next 30 days, レシピ (/recipes) and ガチャ (/gacha).
 * This switch sits above the h1 of both pages so either is one tap away. Not on /recipes/:id or
 * /recipes/new: those keep their 「レシピ一覧」 back link.
 */
import { Link } from "react-router";
import { BookIcon, DiceIcon } from "./Icons";
import "./ChooseNav.css";

export function ChooseNav({ current }: { current: "recipes" | "gacha" }) {
  return (
    <nav className="choose-nav" aria-label="えらびかた">
      <Link to="/recipes" aria-current={current === "recipes" ? "page" : undefined}>
        <BookIcon />
        <span>レシピ</span>
      </Link>
      <Link to="/gacha" aria-current={current === "gacha" ? "page" : undefined}>
        <DiceIcon />
        <span>ガチャ</span>
      </Link>
    </nav>
  );
}
