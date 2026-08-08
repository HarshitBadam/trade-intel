"use client"
import { CalendarDays } from "lucide-react"
import Image from "next/image"

interface NewsCardProps {
  id: string;
  username: string;
  content: string;
  date: string;
  significance: string;
  avatarUrl: string;
  source: string;
  onClick?: () => void;
}

export function NewsCard({ username, content, date, avatarUrl, source, onClick }: NewsCardProps) {
  return (
    <div 
      className={`flex items-start space-x-4 py-4 transition-colors ${
        onClick ? 'cursor-pointer' : ''
      }`} 
      onClick={onClick}
    >
      
      {avatarUrl ? (
        <Image
          src={avatarUrl}
          alt={`${username}'s avatar`}
          width={40}
          height={40}
          className="rounded-full"
        />
      ) : (
        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
          <span className="text-sm font-medium text-muted-foreground">
            {username.charAt(1).toUpperCase()}
          </span>
        </div>
      )}
      <div className="flex-1 space-y-1">
        <p className="text-sm font-medium">{username}</p>
        <p className="text-sm text-muted-foreground">{content}</p>
        <div className="flex items-center gap-2 text-muted-foreground mt-3">
          <CalendarDays className="h-4 w-4" />
          <span className="text-xs">{date}</span>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold">{source}</span>
          </div>
          
        </div>
      </div>
    </div>
  )
}
