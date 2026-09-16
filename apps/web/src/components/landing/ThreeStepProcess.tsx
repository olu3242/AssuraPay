export default function ThreeStepProcess() {
  const steps = [
    {
      number: "01",
      title: "Create or upload your agreement",
      description: "Start from scratch or upload an invoice, proposal, statement of work, conversation or existing contract. AssuraPay identifies key terms and highlights missing information.",
    },
    {
      number: "02",
      title: "Agree on milestones and proof",
      description: "Both parties review deliverables, deadlines, completion criteria, evidence requirements, approval responsibilities and payment conditions.",
    },
    {
      number: "03",
      title: "Complete, verify and release",
      description: "The provider submits evidence. The authorized party reviews completion. When agreed conditions are satisfied, progress to governed payment release through connected financial providers.",
    },
  ];

  return (
    <section id="how-it-works" className="py-20 bg-white border-b border-[#DCE6EF]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <span className="text-xs font-semibold tracking-wider text-[#176BCE] uppercase bg-[#EAF6FD] px-3 py-1 rounded-full border border-[#DCE6EF]">
            AN INTUITIVE PROCESS
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold text-[#071A33] mt-3 mb-4">
            From agreement to confident payment in three steps.
          </h2>
          <p className="text-[#526273] text-base sm:text-lg">
            If you can describe the deal, you can structure it in AssuraPay.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 relative">
          {steps.map((step, idx) => (
            <div
              key={idx}
              className="bg-[#F7FAFC] border border-[#DCE6EF] rounded-2xl p-8 flex flex-col justify-between relative hover:shadow-md transition-shadow"
            >
              <div>
                <span className="text-4xl font-extrabold text-[#176BCE]/30 font-mono mb-4 block">
                  {step.number}
                </span>
                <h3 className="text-xl font-bold text-[#071A33] mb-3">{step.title}</h3>
                <p className="text-[#526273] text-sm leading-relaxed">{step.description}</p>
              </div>
              <div className="mt-8 pt-4 border-t border-[#DCE6EF] flex items-center justify-between text-xs text-[#526273] font-medium">
                <span>Phase {idx + 1} of 3</span>
                <span className="text-[#176BCE]">Governed Workflow</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
