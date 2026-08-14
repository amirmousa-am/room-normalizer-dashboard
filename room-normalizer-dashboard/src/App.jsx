import { NavLink, Route, Routes } from "react-router-dom";
import Playground from "./pages/Playground.jsx";
import RegressionTests from "./pages/RegressionTests.jsx";
import DictionaryManager from "./pages/DictionaryManager.jsx";
import ReviewQueue from "./pages/ReviewQueue.jsx";
import BulkTranslator from "./pages/BulkTranslator.jsx";
import RuleReview from "./pages/RuleReview.jsx";

const NAV = [
  { to: "/", label: "Playground", end: true },
  { to: "/regression", label: "Regression Tests" },
  { to: "/dictionary", label: "Dictionary Manager" },
  { to: "/review-queue", label: "Review Queue" },
  { to: "/bulk", label: "Bulk Translator" },
  { to: "/rule-review", label: "Rule Review" },
];

export default function App() {
  return (
    <div className="min-h-screen bg-base-950 text-base-50">
      <header className="border-b border-base-800 bg-base-900">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center gap-6">
          <span className="font-semibold tracking-tight">Room Normalizer Dashboard</span>
          <nav className="flex gap-1 text-sm">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-md transition-colors ${
                    isActive
                      ? "bg-blue-600 text-white"
                      : "text-base-400 hover:text-base-50 hover:bg-base-800"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Playground />} />
          <Route path="/regression" element={<RegressionTests />} />
          <Route path="/dictionary" element={<DictionaryManager />} />
          <Route path="/review-queue" element={<ReviewQueue />} />
          <Route path="/bulk" element={<BulkTranslator />} />
          <Route path="/rule-review" element={<RuleReview />} />
        </Routes>
      </main>
    </div>
  );
}
