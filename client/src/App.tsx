import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/teacher/Login';
import Register from './pages/teacher/Register';
import Dashboard from './pages/teacher/Dashboard';
import Teach from './pages/teacher/Teach';
import Screen from './pages/teacher/Screen';
import ScreenEntry from './pages/teacher/ScreenEntry';
import Review from './pages/teacher/Review';
import Join from './pages/student/Join';
import Class from './pages/student/Class';
import Watch from './pages/Watch';
import Check from './pages/Check';
import Telemetry from './pages/teacher/Telemetry';
import { useCheckShortcut } from './lib/useCheckShortcut';

export default function App() {
  // Ctrl+Alt+C でどの画面からでも端末チェックへ（戻るボタン付きで開く）
  useCheckShortcut();
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/teach/:id" element={<Teach />} />
      <Route path="/screen/:id" element={<Screen />} />
      {/* 教室モニターの短い入口。テレビのリモコンでも打てる長さにするため */}
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
  );
}
