import React, { createContext, useState, useContext, useEffect } from 'react';
import { TonConnect } from '@tonconnect/sdk';

const GameContext = createContext();

export const useGame = () => useContext(GameContext);

export const GameProvider = ({ children }) => {
  const [language, setLanguage] = useState('ru');
  const [betSize, setBetSize] = useState(null); // 1 или 10
  const [wallet, setWallet] = useState(null);
  const [tonConnector, setTonConnector] = useState(null);
  const [isWalletConnected, setIsWalletConnected] = useState(false);

  // Инициализация TON Connect
  useEffect(() => {
    const connector = new TonConnect({
      manifestUrl: 'https://yourdomain.com/tonconnect-manifest.json',
    });
    setTonConnector(connector);

    // Проверяем, есть ли уже подключенный кошелёк
    if (connector.connected) {
      setWallet(connector.wallet);
      setIsWalletConnected(true);
    }

    // Подписка на изменения состояния
    const unsubscribe = connector.onStatusChange((walletInfo) => {
      if (walletInfo) {
        setWallet(walletInfo);
        setIsWalletConnected(true);
      } else {
        setWallet(null);
        setIsWalletConnected(false);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const connectWallet = async () => {
    if (tonConnector) {
      try {
        await tonConnector.connect();
      } catch (err) {
        console.error('Wallet connection failed:', err);
        throw err;
      }
    }
  };

  const disconnectWallet = async () => {
    if (tonConnector) {
      await tonConnector.disconnect();
      setWallet(null);
      setIsWalletConnected(false);
    }
  };

  const value = {
    language,
    setLanguage,
    betSize,
    setBetSize,
    wallet,
    isWalletConnected,
    connectWallet,
    disconnectWallet,
    tonConnector,
  };

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
};
