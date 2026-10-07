/**
 * How reports are handled, in the same words on the Terms and in every report form (SPEC FR-18).
 *
 * Every report is read by the operator. Only some reports count towards hiding an item
 * automatically (D7: accounts at least REPORTER_MIN_ACCOUNT_AGE_HOURS old that hold a challenge;
 * R8: from at least AUTO_HIDE_MIN_NETWORKS different networks), so auto-hide must never be
 * promised for a report — the /s/:id report form usually creates a brand-new account whose report
 * does not count.
 */
import { AUTO_HIDE_REPORTS, REPORTER_MIN_ACCOUNT_AGE_HOURS } from "@thirty/shared";

/** Every report reaches the operator. */
export const REPORT_REVIEWED = "通報はすべて運営者が確認し、必要なら非表示にします。";

/** When an item is hidden before the operator looks (a condition, not a promise). */
export const AUTO_HIDE_CONDITION = `一定の条件（利用を始めて${REPORTER_MIN_ACCOUNT_AGE_HOURS}時間以上たっていることなど）を満たす${AUTO_HIDE_REPORTS}人から通報があると、確認の前に自動で非表示になることもあります。`;
