export default function Refunds() {
  return (
    <div className="bg-background py-16 min-h-[calc(100vh-16rem)]">
      <div className="container mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-black text-gray-900 font-display mb-8">Refund Policy</h1>
        <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
          <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-8">
            <p className="text-sm text-yellow-800 font-medium">
              This is a placeholder for the legal Refund Policy.
            </p>
          </div>
          <p className="text-gray-600">
            Legal refund content will go here before production launch.
          </p>
        </div>
      </div>
    </div>
  );
}
