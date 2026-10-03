import React from 'react';
import { Lock, Sparkles, Cpu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';

export function WelcomeStep() {
  const { goNext } = useOnboarding();

  const features = [
    {
      icon: Lock,
      title: 'Recording and transcription run on your device',
    },
    {
      icon: Sparkles,
      title: 'Local summaries, or optional external providers',
    },
    {
      icon: Cpu,
      title: 'Local models work offline after download',
    },
  ];

  return (
    <OnboardingContainer
      title="Welcome to Pund-IT Meeting Assistant"
      description="Record and transcribe locally. Summarize with local models or an optional external provider."
      step={1}
      hideProgress={true}
    >
      <div className="flex flex-col items-center space-y-10">
        {/* Divider */}
        <div className="w-16 h-px bg-gray-300" />

        {/* Features Card */}
        <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 shadow-sm p-6 space-y-4">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <div key={index} className="flex items-start gap-3">
                <div className="flex-shrink-0 mt-0.5">
                  <div className="w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center">
                    <Icon className="w-3 h-3 text-gray-700" />
                  </div>
                </div>
                <p className="text-sm text-gray-700 leading-relaxed">{feature.title}</p>
              </div>
            );
          })}
        </div>

        <p className="max-w-md text-xs text-center text-gray-500">
          External summary providers receive transcript content when you use them.
          Model downloads and updates require network access. Optional usage analytics
          is off by default and can be enabled in Settings.
        </p>

        {/* CTA Section */}
        <div className="w-full max-w-xs space-y-3">
          <Button
            onClick={goNext}
            className="w-full h-11 bg-gray-900 hover:bg-gray-800 text-white"
          >
            Get Started
          </Button>
          <p className="text-xs text-center text-gray-500">Takes less than 3 minutes</p>
        </div>
      </div>
    </OnboardingContainer>
  );
}
