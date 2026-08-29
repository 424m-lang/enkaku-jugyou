import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useCheckShortcut } from './lib/useCheckShortcut';
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary';

// 学校・家庭の回線で最初から先生画面やPDF処理一式を読ませない。
// 訪れた画面だけを取得し、ログイン・参加・端末チェックを軽く保つ。
const Login = lazy(() => import('./pages/teacher/Login'));
const Register = lazy(() => import('./pages/teacher/Register'));
const Dashboard = lazy(() => import('./pages/teacher/Dashboard'));
const Teach = lazy(() => import('./pages/teacher/Teach'));
const Screen = lazy(() => import('./pages/teacher/Screen'));
const ScreenEntry = lazy(() => import('./pages/teacher/ScreenEntry'));
const Review = lazy(() => import('./pages/teacher/Review'));
const Join = lazy(() => import('./pages/student/Join'));
const Class = lazy(() => import('./pages/student/Class'));
const Watch = lazy(() => import('./pages/Watch'));
const Check = lazy(() => import('./pages/Check'));
const Telemetry = lazy(() => import('./pages/teacher/Telemetry'));

export default function App() {
  // Ctrl+Alt+C でどの画面からでも端末チェックへ（戻るボタン付きで開く）
  useCheckShortcut();
  // 画面ごとのコードは後から読み込むので、その読み込みが失敗したときに
  // アプリ全体が真っ白にならないよう ChunkErrorBoundary で受け止める
  return (
    <ChunkErrorBoundary>
      <Suspense fallback={<div className="page-center"><p>読み込み中...</p></div>}>
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/teach/:id" element={<Teach />} />
          <Route path="/screen/:id" element={<Screen />} />
          {/* 教室モニター用の短い入口。6文字の短縮コードで開く */}
          <Route path="/m/:code" element={<ScreenEntry />} />
          <Route path="/review/:id" element={<Review />} />
          {/* 開発・検証用の匿名通信集計。通常の先生向け導線には表示しない */}
          <Route path="/telemetry" element={<Telemetry />} />
          <Route path="/join" element={<Join />} />
          <Route path="/class" element={<Class />} />
          {/* 生徒向けの復習ページ（ログイン不要・公開トークン） */}
          <Route path="/watch/:token" element={<Watch />} />
          {/* 現地確認用。訪問先の教室モニターで開いて可否を判断する（ログイン不要）。
              Ctrl+Alt+C でどの画面からでも開ける */}
          <Route path="/check" element={<Check />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ChunkErrorBoundary>
  );
}
