import Link from "next/link";
import { ShieldCheck } from "lucide-react";

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="bg-[#071A33] text-white border-t border-white/10 pt-16 pb-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8 pb-12 border-b border-white/10">
          
          {/* Brand Info */}
          <div className="col-span-2 space-y-4">
            <Link href="/" className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-[#176BCE] flex items-center justify-center text-white">
                <ShieldCheck className="w-5 h-5 text-[#51B8F2]" />
              </div>
              <span className="font-bold text-xl tracking-tight text-white">
                Assura<span className="text-[#51B8F2]">Pay</span>
              </span>
            </Link>
            <p className="text-xs text-[#EAF6FD]/70 max-w-sm leading-relaxed">
              Execution-assurance and conditional-payment platform that turns deals into structured agreements with verified milestones and protected payment release.
            </p>
          </div>

          {/* Links Col 1 */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#51B8F2]">Platform</h4>
            <ul className="space-y-2 text-sm text-[#EAF6FD]/80">
              <li><a href="#product" className="hover:text-white transition-colors">Product</a></li>
              <li><a href="#how-it-works" className="hover:text-white transition-colors">How it works</a></li>
              <li><a href="#use-cases" className="hover:text-white transition-colors">Use cases</a></li>
              <li><a href="#trust" className="hover:text-white transition-colors">Trust & security</a></li>
            </ul>
          </div>

          {/* Links Col 2 */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#51B8F2]">Solutions</h4>
            <ul className="space-y-2 text-sm text-[#EAF6FD]/80">
              <li><Link href="/agreements/new" className="hover:text-white transition-colors">Create agreement</Link></li>
              <li><Link href="/login" className="hover:text-white transition-colors">Log in</Link></li>
              <li><Link href="/contact" className="hover:text-white transition-colors">Contact sales</Link></li>
              <li><Link href="/demo" className="hover:text-white transition-colors">Book a demo</Link></li>
            </ul>
          </div>

          {/* Links Col 3 */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#51B8F2]">Legal</h4>
            <ul className="space-y-2 text-sm text-[#EAF6FD]/80">
              <li><Link href="/terms" className="hover:text-white transition-colors">Terms of service</Link></li>
              <li><Link href="/privacy" className="hover:text-white transition-colors">Privacy policy</Link></li>
              <li><Link href="/trust" className="hover:text-white transition-colors">Compliance & notice</Link></li>
            </ul>
          </div>

        </div>

        <div className="pt-8 flex flex-col sm:flex-row items-center justify-between text-xs text-[#EAF6FD]/60 gap-4">
          <p>© {currentYear} AssuraPay Technologies Inc. All rights reserved.</p>
          <p>Payment release and financial settlement facilitated through connected regulated partners.</p>
        </div>
      </div>
    </footer>
  );
}
