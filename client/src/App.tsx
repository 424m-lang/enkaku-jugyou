import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

function Health() {
  const [status, setStatus] = useState('確認中...');
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setStatus(d.ok ? `サーバ稼働中 (${d.time})` : 'エラー'))
      .catch(() => setStatus('サーバに接続できません'));
  }, []);
  return (
    <div className="page-center">
      <h1>遠隔授業フィードバック</h1>
      <p>{status}</p>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Health />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
