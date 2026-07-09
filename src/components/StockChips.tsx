"use client"
import { Plus } from "lucide-react"
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
          className={`cursor-pointer px-4 py-1.5 rounded-full border-2 border-accent transition-all text-sm ${
            selectedStockId === stock.id ? 'bg-input/40' : 'bg-accent/5 hover:bg-accent/80'
          }`}
        >
          {stock.companyName}
        </button>
      ))}
      {/* <button
        className="cursor-pointer px-4 py-1.5 rounded-full bg-accent/20 hover:bg-accent/80 border-2 border-accent transition-all text-sm flex items-center gap-2 border-dashed"
      >
        <Plus className="h-4 w-4" />
        Add watch stocks here
      </button> */}
    </div>
  )
} 