/**
 * Route table (SPEC "UI"). Pages live one per file in ./pages and are owned separately;
 * this file should not need edits when a page is implemented.
 * /s/:id (public share card) is server-rendered HTML and is not a client route.
 */
import { lazy } from "react";
import { Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import ChallengePage from "./pages/ChallengePage";
import GachaPage from "./pages/GachaPage";
import LogPage from "./pages/LogPage";
import NotFoundPage from "./pages/NotFoundPage";
import RecipeDetailPage from "./pages/RecipeDetailPage";
import RecipeNewPage from "./pages/RecipeNewPage";
import RecipesPage from "./pages/RecipesPage";
import SettingsPage from "./pages/SettingsPage";
import TodayPage from "./pages/TodayPage";
import TogetherPage from "./pages/TogetherPage";

// Less common pages load on demand (Layout wraps the outlet in Suspense + ErrorBoundary).
const ReflectPage = lazy(() => import("./pages/ReflectPage"));
const AboutPage = lazy(() => import("./pages/AboutPage"));
const TermsPage = lazy(() => import("./pages/TermsPage"));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage"));
const ContactPage = lazy(() => import("./pages/ContactPage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<TodayPage />} />
        <Route path="recipes" element={<RecipesPage />} />
        <Route path="recipes/new" element={<RecipeNewPage />} />
        <Route path="recipes/:id" element={<RecipeDetailPage />} />
        <Route path="gacha" element={<GachaPage />} />
        <Route path="together" element={<TogetherPage />} />
        <Route path="log" element={<LogPage />} />
        <Route path="c/:id" element={<ChallengePage />} />
        <Route path="c/:id/reflect" element={<ReflectPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="about" element={<AboutPage />} />
        <Route path="terms" element={<TermsPage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        <Route path="contact" element={<ContactPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
