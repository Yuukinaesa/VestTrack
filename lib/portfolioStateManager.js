// lib/portfolioStateManager.js
// Professional Portfolio State Manager - Similar to real trading platforms

import { calculatePositionFromTransactions, cleanFractionalLots } from './utils';

class PortfolioStateManager {
  constructor() {
    this.state = {
      assets: { stocks: [], crypto: [] },
      transactions: [],
      prices: {},
      exchangeRate: null,
      lastUpdate: null,
      isInitialized: false,
      pendingUpdates: new Set(),
      updateQueue: []
    };
    
    this.subscribers = new Set();
    this.updateInProgress = false;
    this.batchUpdates = [];
    this.lastTransactionHash = '';
  }

  // Subscribe to state changes
  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  // Notify all subscribers
  notify() {
    this.subscribers.forEach(callback => {
      try {
        callback(this.getState());
      } catch (error) {
        console.error('Error in portfolio state subscriber:', error);
      }
    });
  }

  // Get current state
  getState() {
    return {
      ...this.state,
      assets: { ...this.state.assets },
      transactions: [...this.state.transactions],
      prices: { ...this.state.prices }
    };
  }

  // Initialize portfolio
  initialize(initialAssets, initialTransactions = []) {
    this.state.assets = initialAssets || { stocks: [], crypto: [] };
    this.state.transactions = initialTransactions;
    this.state.isInitialized = true;
    this.state.lastUpdate = new Date().toISOString();
    this.notify();
  }

  // Update transactions with proper deduplication and race condition handling
  updateTransactions(newTransactions) {
    if (!Array.isArray(newTransactions)) return;

    // Remove duplicate transactions by ID
    const uniqueTransactions = newTransactions.filter((transaction, index, self) => 
      index === self.findIndex(t => t.id === transaction.id)
    );

    if (uniqueTransactions.length !== newTransactions.length) {
      console.log(`Removed ${newTransactions.length - uniqueTransactions.length} duplicate transactions`);
    }

    // Create hash for comparison
    const transactionHash = JSON.stringify(uniqueTransactions.map(t => t.id).sort());
    
    // Skip if no changes
    if (transactionHash === this.lastTransactionHash) {
      console.log('No transaction changes detected, skipping update');
      return;
    }

    // Prevent race conditions by checking if update is in progress
    if (this.updateInProgress) {
      console.log('Update in progress, queuing transaction update');
      this.batchUpdates.push({ type: 'transactions', data: uniqueTransactions });
      return;
    }

    this.lastTransactionHash = transactionHash;
    this.state.transactions = uniqueTransactions;
    
    console.log(`Updated transactions: ${uniqueTransactions.length} unique transactions`);
    
    // Rebuild portfolio from transactions
    this.rebuildPortfolio();
  }

  // Update prices with batching and race condition handling
  updatePrices(newPrices) {
    if (!newPrices || typeof newPrices !== 'object') return;

    const hasChanges = Object.keys(newPrices).some(key => 
      this.state.prices[key]?.price !== newPrices[key]?.price
    );

    if (!hasChanges) return;

    // Prevent race conditions by checking if update is in progress
    if (this.updateInProgress) {
      console.log('Update in progress, queuing price update');
      this.batchUpdates.push({ type: 'prices', data: newPrices });
      return;
    }

    this.state.prices = { ...this.state.prices, ...newPrices };
    this.state.lastUpdate = new Date().toISOString();
    
    // Update portfolio values without full rebuild
    this.updatePortfolioValues();
  }

  // Update exchange rate
  updateExchangeRate(rate) {
    // Handle case where rate might be an event object instead of a number
    const numericRate = typeof rate === 'number' ? rate : null;
    
    if (this.state.exchangeRate === numericRate) return;
    
    this.state.exchangeRate = numericRate;
    this.state.lastUpdate = new Date().toISOString();
    
    // Update portfolio values
    this.updatePortfolioValues();
  }

  // Rebuild portfolio from transactions (like real trading platforms)
  rebuildPortfolio() {
    if (!this.state.isInitialized || this.state.transactions.length === 0) {
      return;
    }

    console.log('PortfolioStateManager: Rebuilding portfolio from', this.state.transactions.length, 'transactions');

    const newAssets = this.buildAssetsFromTransactions(
      this.state.transactions,
      this.state.prices
    );

    this.state.assets = newAssets;
    this.state.lastUpdate = new Date().toISOString();
    this.notify();
  }

  // Build assets from transactions (optimized)
  buildAssetsFromTransactions(transactions, prices) {
    console.log('Building assets from transactions:', transactions.length, 'transactions');
    console.log('Available prices:', Object.keys(prices));
    
    const stocksMap = new Map();
    const cryptoMap = new Map();

    // Sort transactions by timestamp to ensure chronological processing
    const sortedTransactions = [...transactions].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    console.log(`Processing ${sortedTransactions.length} transactions chronologically...`);
    sortedTransactions.forEach(tx => {
      console.log(`Processing transaction: ${tx.type} ${tx.assetType} ${tx.ticker || tx.symbol} amount: ${tx.amount} at ${tx.timestamp}`);
      if (tx.type === 'delete') {
        // For delete transactions, remove the asset from the maps
        if (tx.assetType === 'stock' && tx.ticker) {
          const key = tx.ticker.toUpperCase();
          stocksMap.delete(key);
          console.log(`Deleted stock ${key}`);
        } else if (tx.assetType === 'crypto' && tx.symbol) {
          const key = tx.symbol.toUpperCase();
          cryptoMap.delete(key);
          console.log(`Deleted crypto ${key}`);
        }
        return;
      }

      // Process non-delete transactions
      if (tx.assetType === 'stock' && tx.ticker) {
        const key = tx.ticker.toUpperCase();
        if (!stocksMap.has(key)) stocksMap.set(key, []);
        stocksMap.get(key).push(tx);
        console.log(`Added ${tx.type} transaction for stock ${key}: amount=${tx.amount}, price=${tx.price}`);
      } else if (tx.assetType === 'crypto' && tx.symbol) {
        const key = tx.symbol.toUpperCase();
        if (!cryptoMap.has(key)) cryptoMap.set(key, []);
        cryptoMap.get(key).push(tx);
        console.log(`Added ${tx.type} transaction for crypto ${key}: amount=${tx.amount}, price=${tx.price}`);
      }
    });

    console.log(`Building assets from maps - Stocks: ${stocksMap.size}, Crypto: ${cryptoMap.size}`);
    
    // Build stocks
    const stocks = Array.from(stocksMap.entries())
      .map(([ticker, txs]) => {
        const priceData = prices[`${ticker}.JK`] || prices[ticker];
        const currentPrice = priceData?.price || 0;
        
        const position = calculatePositionFromTransactions(txs, currentPrice, this.state.exchangeRate);
        
        if (position.amount <= 0) return null;

        // Debug logging for average price calculation
        console.log(`Building stock ${ticker}:`, {
          amount: position.amount,
          avgPrice: position.avgPrice,
          currentPrice: currentPrice,
          totalCost: position.totalCost,
          currency: 'IDR'
        });

        // Ensure shares are always multiples of 100 (whole lots)
        const totalShares = position.amount;
        const calculatedLots = totalShares / 100;
        const wholeLots = cleanFractionalLots(calculatedLots);
        
        // If there are remaining shares that don't make a whole lot, log a warning
        const remainingShares = totalShares % 100;
        if (remainingShares > 0) {
          console.warn(`Stock ${ticker} has ${remainingShares} remaining shares that don't make a whole lot. Total shares: ${totalShares}, calculated lots: ${calculatedLots}, cleaned lots: ${wholeLots}`);
        }
        
        return {
          ticker,
          lots: wholeLots, // Only display whole lots
          avgPrice: position.avgPrice,
          totalCost: position.totalCost,
          totalCostIDR: position.totalCostIDR,
          totalCostUSD: position.totalCostUSD,
          currentPrice,
          gain: position.gain,
          gainIDR: position.gainIDR,
          gainUSD: position.gainUSD,
          porto: position.porto,
          portoIDR: position.portoIDR,
          portoUSD: position.portoUSD,
          gainPercentage: position.gainPercentage,
          currency: 'IDR',
          assetType: 'stock',
          lastUpdate: new Date().toISOString()
        };
      })
      .filter(Boolean);

    // Build crypto
    const crypto = Array.from(cryptoMap.entries())
      .map(([symbol, txs]) => {
        console.log(`Processing crypto ${symbol} with ${txs.length} transactions:`, txs.map(tx => ({
          id: tx.id,
          type: tx.type,
          amount: tx.amount,
          price: tx.price,
          timestamp: tx.timestamp
        })));
        const priceData = prices[symbol];
        const currentPrice = priceData?.price || 0;
        
        const position = calculatePositionFromTransactions(txs, currentPrice, this.state.exchangeRate);
        
        if (position.amount <= 0) {
          console.log(`Skipping ${symbol} - amount is 0 or negative`);
          return null;
        }

        console.log(`Built crypto asset ${symbol}:`, {
          amount: position.amount,
          avgPrice: position.avgPrice,
          currentPrice,
          gain: position.gain
        });

        return {
          symbol,
          amount: position.amount,
          avgPrice: position.avgPrice,
          totalCost: position.totalCost,
          totalCostIDR: position.totalCostIDR,
          totalCostUSD: position.totalCostUSD,
          currentPrice,
          gain: position.gain,
          gainIDR: position.gainIDR,
          gainUSD: position.gainUSD,
          porto: position.porto,
          portoIDR: position.portoIDR,
          portoUSD: position.portoUSD,
          gainPercentage: position.gainPercentage,
          currency: 'USD',
          assetType: 'crypto',
          lastUpdate: new Date().toISOString()
        };
      })
      .filter(Boolean);

    console.log(`Final portfolio - Stocks: ${stocks.length}, Crypto: ${crypto.length}`);
    return { stocks, crypto };
  }

  // Update portfolio values without full rebuild
  updatePortfolioValues() {
    if (!this.state.isInitialized) return;

    console.log('Updating portfolio values with current prices');
    console.log('Current exchange rate:', this.state.exchangeRate);
    console.log('Available prices:', Object.keys(this.state.prices));

    // Update stocks portfolio values
    this.state.assets.stocks = this.state.assets.stocks.map(stock => {
      const priceData = this.state.prices[`${stock.ticker}.JK`] || this.state.prices[stock.ticker];
      const currentPrice = priceData?.price || stock.currentPrice || 0;
      
      if (currentPrice > 0) {
        // Recalculate portfolio value for stocks
        const totalShares = stock.lots * 100; // 1 lot = 100 shares for display
        const currentValue = currentPrice * totalShares;
        const costBasis = stock.avgPrice * totalShares;
        const gain = currentValue - costBasis;
        const gainUSD = this.state.exchangeRate && this.state.exchangeRate > 0 ? Math.round((gain / this.state.exchangeRate) * 100) / 100 : 0;
        const gainPercentage = costBasis > 0 ? (gain / costBasis) * 100 : 0;
        
        console.log(`Updated stock ${stock.ticker}:`, {
          lots: stock.lots,
          currentPrice,
          currentValue,
          costBasis,
          gain,
          gainUSD,
          gainPercentage
        });
        
        return {
          ...stock,
          currentPrice,
          porto: currentValue,
          portoIDR: currentValue,
          portoUSD: this.state.exchangeRate && this.state.exchangeRate > 0 ? Math.round((currentValue / this.state.exchangeRate) * 100) / 100 : 0,
          gain,
          gainIDR: gain,
          gainUSD,
          gainPercentage,
          lastUpdate: new Date().toISOString()
        };
      }
      
      return stock;
    });

    // Update crypto portfolio values
    this.state.assets.crypto = this.state.assets.crypto.map(crypto => {
      const priceData = this.state.prices[crypto.symbol];
      const currentPrice = priceData?.price || crypto.currentPrice || 0;
      
      if (currentPrice > 0) {
        // Recalculate portfolio value for crypto
        const currentValue = currentPrice * crypto.amount;
        const costBasis = crypto.avgPrice * crypto.amount;
        const gain = currentValue - costBasis;
        const gainIDR = this.state.exchangeRate && this.state.exchangeRate > 0 ? Math.round(gain * this.state.exchangeRate) : 0;
        const gainPercentage = costBasis > 0 ? (gain / costBasis) * 100 : 0;
        
        console.log(`Updated crypto ${crypto.symbol}:`, {
          amount: crypto.amount,
          currentPrice,
          currentValue,
          costBasis,
          gain,
          gainIDR,
          gainPercentage
        });
        
        return {
          ...crypto,
          currentPrice,
          porto: currentValue,
          portoUSD: currentValue,
          portoIDR: this.state.exchangeRate && this.state.exchangeRate > 0 ? Math.round(currentValue * this.state.exchangeRate) : 0,
          gain,
          gainUSD: gain,
          gainIDR,
          gainPercentage,
          lastUpdate: new Date().toISOString()
        };
      }
      
      return crypto;
    });

    this.state.lastUpdate = new Date().toISOString();
    console.log('Portfolio values updated successfully');
    this.notify();
  }

  // Add transaction with proper state management
  async addTransaction(transaction) {
    const transactionId = transaction.id || Date.now().toString();
    
    // Check if transaction is already pending
    if (this.state.pendingUpdates.has(transactionId)) {
      console.log(`Transaction ${transactionId} already pending, skipping`);
      return;
    }
    
    // Check if transaction already exists in current transactions
    const existingTransaction = this.state.transactions.find(t => t.id === transactionId);
    if (existingTransaction) {
      console.log(`Transaction ${transactionId} already exists, skipping`);
      return;
    }
    
    // Add to pending updates
    this.state.pendingUpdates.add(transactionId);
    
    // Add to queue for batch processing
    this.batchUpdates.push(transaction);
    
    // Process batch if not already in progress
    if (!this.updateInProgress) {
      this.processBatchUpdates();
    }
  }

  // Process batch updates
  async processBatchUpdates() {
    if (this.updateInProgress || this.batchUpdates.length === 0) return;

    this.updateInProgress = true;

    try {
      // Process all pending updates
      const updates = [...this.batchUpdates];
      this.batchUpdates = [];

      // Update transactions
      const newTransactions = [...this.state.transactions];
      const processedIds = new Set();
      
      updates.forEach(update => {
        const transactionId = update.id;
        
        // Skip if already processed in this batch
        if (processedIds.has(transactionId)) {
          console.log(`Skipping duplicate transaction in batch: ${transactionId}`);
          return;
        }
        
        processedIds.add(transactionId);
        
        const existingIndex = newTransactions.findIndex(t => t.id === transactionId);
        if (existingIndex >= 0) {
          newTransactions[existingIndex] = update;
        } else {
          newTransactions.unshift(update);
        }
      });

      // Update state
      this.updateTransactions(newTransactions);

      // Clear pending updates
      this.state.pendingUpdates.clear();

    } catch (error) {
      console.error('Error processing batch updates:', error);
    } finally {
      this.updateInProgress = false;
      
      // Process any new updates that came in during processing
      if (this.batchUpdates.length > 0) {
        setTimeout(() => this.processBatchUpdates(), 0);
      }
    }
  }

  // Delete asset with proper cleanup
  deleteAsset(assetType, symbol) {
    const deleteTransaction = {
      id: `delete_${Date.now()}`,
      assetType,
      [assetType === 'stock' ? 'ticker' : 'symbol']: symbol.toUpperCase(),
      type: 'delete',
      amount: 0,
      price: 0,
      total: 0,
      timestamp: new Date().toISOString(),
      description: 'Asset deleted by user'
    };

    this.addTransaction(deleteTransaction);
  }

  // Get asset by symbol
  getAsset(assetType, symbol) {
    const assets = this.state.assets[assetType === 'stock' ? 'stocks' : 'crypto'];
    return assets.find(asset => 
      (assetType === 'stock' ? asset.ticker : asset.symbol).toUpperCase() === symbol.toUpperCase()
    );
  }

  // Get portfolio summary
  getPortfolioSummary() {
    const stocks = this.state.assets.stocks;
    const crypto = this.state.assets.crypto;

    const totalValue = stocks.reduce((sum, stock) => sum + (stock.porto || 0), 0) +
                      crypto.reduce((sum, crypto) => sum + (crypto.porto || 0), 0);

    const totalCost = stocks.reduce((sum, stock) => sum + (stock.totalCost || 0), 0) +
                     crypto.reduce((sum, crypto) => sum + (crypto.totalCost || 0), 0);

    const totalGain = totalValue - totalCost;
    const totalGainPercentage = totalCost > 0 ? (totalGain / totalCost) * 100 : 0;

    return {
      totalValue,
      totalCost,
      totalGain,
      totalGainPercentage,
      assetCount: stocks.length + crypto.length,
      lastUpdate: this.state.lastUpdate
    };
  }

  // Reset state
  reset() {
    this.state = {
      assets: { stocks: [], crypto: [] },
      transactions: [],
      prices: {},
      exchangeRate: null,
      lastUpdate: null,
      isInitialized: false,
      pendingUpdates: new Set(),
      updateQueue: []
    };
    this.lastTransactionHash = '';
    this.updateInProgress = false;
    this.batchUpdates = [];
    this.notify();
  }
}

// Create singleton instance
const portfolioStateManager = new PortfolioStateManager();

export default portfolioStateManager; 