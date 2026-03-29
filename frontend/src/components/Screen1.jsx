import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import './Screen1.css';

export default function Screen1({ onNext }) {
  const { t, i18n } = useTranslation();
  const [bet, setBet] = useState(1);
  const [lang, setLang] = useState('ru');

  const changeLanguage = (lng) => {
    i18n.changeLanguage(lng);
    setLang(lng);
  };

  const handleSubmit = () => {
    onNext(bet, lang);
  };

  return (
    <div className="screen1">
      <div className="banner">Рекламный баннер</div>
      <div className="content">
        <div className="language-selector">
          <button onClick={() => changeLanguage('ru')}>Русский</button>
          <button onClick={() => changeLanguage('en')}>English</button>
        </div>
        <div className="bet-selector">
          <label>
            <input type="radio" value={1} checked={bet === 1} onChange={() => setBet(1)} />
            1 TON
          </label>
          <label>
            <input type="radio" value={10} checked={bet === 10} onChange={() => setBet(10)} />
            10 TON
          </label>
        </div>
        <button onClick={handleSubmit} className="next-button">{t('continue')}</button>
      </div>
    </div>
  );
}
