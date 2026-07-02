"use client"
import { mockStockData } from "@/data/mockStocks";

interface StockChipsProps {
  onStockSelect: (stockId: number | null) => void;
  selectedStockId: number | null;
}

export function StockChips({ onStockSelect, selectedStockId }: StockChipsProps) {
  return (
    <div className="flex flex-wrap gap-3 items-center w-full">
      {mockStockData.map((stock) => (
        <button
          key={stock.id}
          onClick={() => onStockSelect(selectedStockId === stock.id ? null : stock.id)}
          className={`cursor-pointer rounded-full px-4 py-1.5 text-sm text-foreground transition-colors duration-150 ease-out ${
            selectedStockId === stock.id
              ? 'bg-muted shadow-[inset_0_1px_3px_rgba(0,0,0,0.10)] font-medium'
              : 'bg-card shadow-[0_2px_5px_-1px_rgba(0,0,0,0.14)] hover:bg-muted'
          }`}
        >
          {stock.companyName}
        </button>
      ))}
    </div>
  )
} 