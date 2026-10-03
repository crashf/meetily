import './globals.css'
import 'sonner/dist/styles.css'
import { Source_Sans_3 } from 'next/font/google'
import ClientLayout from './ClientLayout'

export { metadata } from './metadata'

const sourceSans3 = Source_Sans_3({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-source-sans-3',
})

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${sourceSans3.variable} font-sans antialiased`}>
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  )
}
